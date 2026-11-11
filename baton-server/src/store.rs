use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, ErrorCode as SqlErrorCode, OptionalExtension};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{
    EnvView, MemberView, Peer, RoomView, TaskSummary, ROOM_CODE_CHARSET, ROOM_CODE_LEN,
    STATUS_PENDING,
};

pub const TASK_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_ROOMS_PER_USER: i64 = 10;
pub const MAX_MEMBERS_PER_ROOM: i64 = 10;
pub const MAX_RELATED_TASKS: i64 = 200;
pub const MAX_PENDING_INBOX: i64 = 50;

const SCHEMA: &str = r#"
CREATE TABLE rooms (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE members (
    room_code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, user_id),
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
CREATE TABLE profiles (
    user_id TEXT PRIMARY KEY,
    environments TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    from_user TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_user TEXT NOT NULL,
    to_name TEXT NOT NULL,
    env TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_to_status ON tasks(to_user, status);
CREATE INDEX idx_tasks_from ON tasks(from_user);
CREATE INDEX idx_tasks_expires ON tasks(expires_at);
CREATE INDEX idx_members_user ON members(user_id);
"#;

const VISIBILITY_SCHEMA: &str = r#"
ALTER TABLE tasks ADD COLUMN from_visibility TEXT NOT NULL DEFAULT 'active'
    CHECK (from_visibility IN ('active', 'archived', 'deleted'));
ALTER TABLE tasks ADD COLUMN to_visibility TEXT NOT NULL DEFAULT 'active'
    CHECK (to_visibility IN ('active', 'archived', 'deleted'));
CREATE TABLE task_tombstones (task_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX idx_task_tombstones_expires ON task_tombstones(expires_at);
"#;

const TASK_SUMMARY_COLUMNS: &str = "task_id, room, from_user, from_name, to_user, to_name, \
     env, title, status, created_at, expires_at, from_visibility, to_visibility";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("invalid request")]
    Invalid,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("capacity exceeded")]
    CapacityExceeded,
    #[error("unsupported schema version {0}")]
    UnsupportedSchema(i64),
    #[error("internal store error: {0}")]
    Internal(String),
    #[error("store worker unavailable")]
    Unavailable,
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone)]
pub struct HelloReply {
    pub name_changed: bool,
    pub peers: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CreateRoomReply {
    pub code: String,
    pub room: RoomView,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct JoinRoomReply {
    pub code: String,
    pub created: bool,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LeaveRoomReply {
    pub code: String,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DisbandRoomReply {
    pub code: String,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SendTaskReply {
    pub task: TaskSummary,
    pub created: bool,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GetTaskReply {
    pub task: TaskSummary,
    pub brief: String,
}

#[derive(Debug, Clone)]
pub struct RespondTaskReply {
    pub task: TaskSummary,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TaskVisibilityReply {
    pub task_id: String,
    pub purged: bool,
    pub notify: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SyncReply {
    pub rooms: Vec<RoomView>,
    pub tasks: Vec<TaskSummary>,
}

#[derive(Debug, Clone)]
pub struct PeersReply {
    pub peers: Vec<String>,
}

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

pub struct Store {
    tx: mpsc::Sender<Job>,
}

impl Store {
    pub fn open(path: &Path) -> StoreResult<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if path != Path::new(":memory:") {
            let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(StoreError::Internal(format!("journal_mode is {mode}")));
            }
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 3 {
            return Err(StoreError::UnsupportedSchema(version));
        }
        if version < 3 {
            let tx = conn.transaction()?;
            if version == 0 {
                tx.execute_batch(SCHEMA)?;
            } else if version == 1 {
                tx.execute_batch(
                    "CREATE TABLE profiles (\
                    user_id TEXT PRIMARY KEY,\
                    environments TEXT NOT NULL DEFAULT '[]'\
                );",
                )?;
            }
            tx.execute_batch(VISIBILITY_SCHEMA)?;
            tx.pragma_update(None, "user_version", 3_i64)?;
            tx.commit()?;
        }

        let (tx, mut rx) = mpsc::channel::<Job>(64);
        std::thread::Builder::new()
            .name("baton-db".into())
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    job(&mut conn);
                }
            })
            .map_err(|error| StoreError::Internal(error.to_string()))?;
        Ok(Self { tx })
    }

    async fn call<T, F>(&self, f: F) -> StoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StoreResult<T> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let _ = reply_tx.send(f(conn));
        });
        self.tx
            .send(job)
            .await
            .map_err(|_| StoreError::Unavailable)?;
        reply_rx.await.map_err(|_| StoreError::Unavailable)?
    }

    pub async fn hello(
        &self,
        user_id: &str,
        display_name: &str,
        environments: Option<Vec<EnvView>>,
    ) -> StoreResult<HelloReply> {
        let user_id = user_id.to_owned();
        let display_name = display_name.to_owned();
        self.call(move |conn| hello_impl(conn, &user_id, &display_name, environments.as_deref()))
            .await
    }

    pub async fn set_environments(
        &self,
        user_id: &str,
        environments: Vec<EnvView>,
    ) -> StoreResult<PeersReply> {
        let user_id = user_id.to_owned();
        self.call(move |conn| set_environments_impl(conn, &user_id, &environments))
            .await
    }

    pub async fn sync(&self, user_id: &str, now_ms: i64) -> StoreResult<SyncReply> {
        let user_id = user_id.to_owned();
        self.call(move |conn| sync_impl(conn, &user_id, now_ms))
            .await
    }

    pub async fn create_room(
        &self,
        user_id: &str,
        display_name: &str,
        name: &str,
        now_ms: i64,
    ) -> StoreResult<CreateRoomReply> {
        let user_id = user_id.to_owned();
        let display_name = display_name.to_owned();
        let name = name.to_owned();
        self.call(move |conn| create_room_impl(conn, &user_id, &display_name, &name, now_ms))
            .await
    }

    pub async fn join_room(
        &self,
        user_id: &str,
        display_name: &str,
        code: &str,
        now_ms: i64,
    ) -> StoreResult<JoinRoomReply> {
        let user_id = user_id.to_owned();
        let display_name = display_name.to_owned();
        let code = code.to_owned();
        self.call(move |conn| join_room_impl(conn, &user_id, &display_name, &code, now_ms))
            .await
    }

    pub async fn leave_room(&self, user_id: &str, code: &str) -> StoreResult<LeaveRoomReply> {
        let user_id = user_id.to_owned();
        let code = code.to_owned();
        self.call(move |conn| leave_room_impl(conn, &user_id, &code))
            .await
    }

    pub async fn disband_room(&self, user_id: &str, code: &str) -> StoreResult<DisbandRoomReply> {
        let user_id = user_id.to_owned();
        let code = code.to_owned();
        self.call(move |conn| disband_room_impl(conn, &user_id, &code))
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_task(
        &self,
        from_user: &str,
        task_id: &str,
        room: &str,
        to_user: &str,
        env: &str,
        title: &str,
        brief: &str,
        now_ms: i64,
    ) -> StoreResult<SendTaskReply> {
        let from_user = from_user.to_owned();
        let task_id = task_id.to_owned();
        let room = room.to_owned();
        let to_user = to_user.to_owned();
        let env = env.to_owned();
        let title = title.to_owned();
        let brief = brief.to_owned();
        self.call(move |conn| {
            send_task_impl(
                conn, &from_user, &task_id, &room, &to_user, &env, &title, &brief, now_ms,
            )
        })
        .await
    }

    pub async fn get_task(
        &self,
        user_id: &str,
        task_id: &str,
        now_ms: i64,
    ) -> StoreResult<GetTaskReply> {
        let user_id = user_id.to_owned();
        let task_id = task_id.to_owned();
        self.call(move |conn| get_task_impl(conn, &user_id, &task_id, now_ms))
            .await
    }

    pub async fn respond_task(
        &self,
        user_id: &str,
        task_id: &str,
        decision: &str,
        clock: impl FnOnce() -> i64 + Send + 'static,
    ) -> StoreResult<RespondTaskReply> {
        let user_id = user_id.to_owned();
        let task_id = task_id.to_owned();
        let decision = decision.to_owned();
        self.call(move |conn| respond_task_impl(conn, &user_id, &task_id, &decision, clock))
            .await
    }

    pub async fn delete_expired(&self, now_ms: i64) -> StoreResult<u64> {
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let count = tx.execute("DELETE FROM tasks WHERE expires_at <= ?1", params![now_ms])?;
            tx.execute(
                "DELETE FROM task_tombstones WHERE expires_at <= ?1",
                params![now_ms],
            )?;
            tx.commit()?;
            Ok(count as u64)
        })
        .await
    }

    pub async fn set_task_visibility(
        &self,
        user_id: &str,
        task_id: &str,
        visibility: &str,
        now_ms: i64,
    ) -> StoreResult<TaskVisibilityReply> {
        let user_id = user_id.to_owned();
        let task_id = task_id.to_owned();
        let visibility = visibility.to_owned();
        self.call(move |conn| {
            set_task_visibility_impl(conn, &user_id, &task_id, &visibility, now_ms)
        })
        .await
    }

    pub async fn peer_users(&self, user_id: &str) -> StoreResult<PeersReply> {
        let user_id = user_id.to_owned();
        self.call(move |conn| peer_ids(conn, &user_id).map(|peers| PeersReply { peers }))
            .await
    }

    pub async fn ping(&self) -> StoreResult<()> {
        self.call(|conn| {
            conn.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await
    }
}

#[derive(Debug, Clone)]
struct TaskRow {
    task_id: String,
    room: String,
    from_user: String,
    from_name: String,
    to_user: String,
    to_name: String,
    env: String,
    title: String,
    brief: String,
    status: String,
    from_visibility: String,
    to_visibility: String,
    created_at: i64,
    expires_at: i64,
}

impl TaskRow {
    fn summary(&self) -> TaskSummary {
        TaskSummary {
            task_id: self.task_id.clone(),
            room: self.room.clone(),
            from: Peer {
                user_id: self.from_user.clone(),
                display_name: self.from_name.clone(),
            },
            to: Peer {
                user_id: self.to_user.clone(),
                display_name: self.to_name.clone(),
            },
            env: self.env.clone(),
            title: self.title.clone(),
            status: self.status.clone(),
            from_visibility: self.from_visibility.clone(),
            to_visibility: self.to_visibility.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
        }
    }
}

fn encode_environments(environments: &[EnvView]) -> String {
    serde_json::to_string(environments).unwrap_or_else(|_| "[]".to_owned())
}

fn decode_environments(text: &str) -> Vec<EnvView> {
    serde_json::from_str(text).unwrap_or_default()
}

fn hello_impl(
    conn: &mut Connection,
    user_id: &str,
    display_name: &str,
    environments: Option<&[EnvView]>,
) -> StoreResult<HelloReply> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE members SET display_name = ?1 WHERE user_id = ?2 AND display_name <> ?1",
        params![display_name, user_id],
    )? > 0;
    let mut env_changed = false;
    if let Some(environments) = environments {
        let environments_json = encode_environments(environments);
        env_changed = tx.execute(
            "INSERT INTO profiles (user_id, environments) VALUES (?1, ?2) \
             ON CONFLICT(user_id) DO UPDATE SET environments = excluded.environments \
             WHERE profiles.environments <> excluded.environments",
            params![user_id, environments_json],
        )? > 0;
    }
    let peers = peer_ids(&tx, user_id)?;
    tx.commit()?;
    Ok(HelloReply {
        name_changed: changed || env_changed,
        peers,
    })
}

fn set_environments_impl(
    conn: &mut Connection,
    user_id: &str,
    environments: &[EnvView],
) -> StoreResult<PeersReply> {
    let json = encode_environments(environments);
    conn.execute(
        "INSERT INTO profiles (user_id, environments) VALUES (?1, ?2) \
         ON CONFLICT(user_id) DO UPDATE SET environments = excluded.environments",
        params![user_id, json],
    )?;
    Ok(PeersReply {
        peers: peer_ids(conn, user_id)?,
    })
}

fn sync_impl(conn: &mut Connection, user_id: &str, now_ms: i64) -> StoreResult<SyncReply> {
    let codes = {
        let mut stmt = conn.prepare(
            "SELECT r.code FROM rooms r JOIN members m ON m.room_code = r.code \
             WHERE m.user_id = ?1 ORDER BY r.created_at, r.code",
        )?;
        let rows = stmt.query_map(params![user_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut rooms = Vec::with_capacity(codes.len());
    for code in codes {
        rooms.push(room_view(conn, &code)?);
    }

    let tasks = {
        let sql = format!(
            "SELECT {TASK_SUMMARY_COLUMNS} FROM tasks \
             WHERE ((from_user = ?1 AND from_visibility != 'deleted') \
                OR (to_user = ?1 AND to_visibility != 'deleted')) AND expires_at > ?2 \
             ORDER BY created_at, task_id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![user_id, now_ms], task_summary_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(SyncReply { rooms, tasks })
}

fn create_room_impl(
    conn: &mut Connection,
    user_id: &str,
    display_name: &str,
    name: &str,
    now_ms: i64,
) -> StoreResult<CreateRoomReply> {
    let tx = conn.transaction()?;
    let room_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM members WHERE user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )?;
    if room_count >= MAX_ROOMS_PER_USER {
        return Err(StoreError::CapacityExceeded);
    }

    let mut code = None;
    for _ in 0..5 {
        let candidate = generate_room_code();
        match tx.execute(
            "INSERT INTO rooms (code, name, owner_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![candidate, name, user_id, now_ms],
        ) {
            Ok(_) => {
                code = Some(candidate);
                break;
            }
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == SqlErrorCode::ConstraintViolation => {}
            Err(error) => return Err(error.into()),
        }
    }
    let code = code.ok_or_else(|| StoreError::Internal("room code collision".into()))?;
    tx.execute(
        "INSERT INTO members (room_code, user_id, display_name, joined_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![code, user_id, display_name, now_ms],
    )?;
    let room = RoomView {
        code: code.clone(),
        name: name.to_owned(),
        owner_id: user_id.to_owned(),
        created_at: now_ms,
        members: vec![MemberView {
            user_id: user_id.to_owned(),
            display_name: display_name.to_owned(),
            online: false,
            environments: Vec::new(),
        }],
    };
    tx.commit()?;
    Ok(CreateRoomReply {
        code,
        room,
        notify: vec![user_id.to_owned()],
    })
}

fn join_room_impl(
    conn: &mut Connection,
    user_id: &str,
    display_name: &str,
    code: &str,
    now_ms: i64,
) -> StoreResult<JoinRoomReply> {
    let tx = conn.transaction()?;
    let exists: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT name, owner_id, created_at FROM rooms WHERE code = ?1",
            params![code],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::NotFound);
    }
    let already: Option<String> = tx
        .query_row(
            "SELECT display_name FROM members WHERE room_code = ?1 AND user_id = ?2",
            params![code, user_id],
            |row| row.get(0),
        )
        .optional()?;
    if already.is_some() {
        return Ok(JoinRoomReply {
            code: code.to_owned(),
            created: false,
            notify: Vec::new(),
        });
    }

    let room_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM members WHERE user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )?;
    if room_count >= MAX_ROOMS_PER_USER {
        return Err(StoreError::CapacityExceeded);
    }

    let member_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM members WHERE room_code = ?1",
        params![code],
        |row| row.get(0),
    )?;
    if member_count >= MAX_MEMBERS_PER_ROOM {
        return Err(StoreError::CapacityExceeded);
    }
    tx.execute(
        "INSERT INTO members (room_code, user_id, display_name, joined_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![code, user_id, display_name, now_ms],
    )?;
    let notify = member_ids(&tx, code)?;
    tx.commit()?;
    Ok(JoinRoomReply {
        code: code.to_owned(),
        created: true,
        notify,
    })
}

fn leave_room_impl(
    conn: &mut Connection,
    user_id: &str,
    code: &str,
) -> StoreResult<LeaveRoomReply> {
    let tx = conn.transaction()?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT owner_id FROM rooms WHERE code = ?1",
            params![code],
            |row| row.get(0),
        )
        .optional()?;
    let Some(owner) = owner else {
        return Ok(LeaveRoomReply {
            code: code.to_owned(),
            notify: Vec::new(),
        });
    };
    if owner == user_id {
        return Err(StoreError::Forbidden);
    }
    let is_member: Option<String> = tx
        .query_row(
            "SELECT user_id FROM members WHERE room_code = ?1 AND user_id = ?2",
            params![code, user_id],
            |row| row.get(0),
        )
        .optional()?;
    if is_member.is_none() {
        return Ok(LeaveRoomReply {
            code: code.to_owned(),
            notify: Vec::new(),
        });
    }
    let before = member_ids(&tx, code)?;
    tx.execute(
        "DELETE FROM members WHERE room_code = ?1 AND user_id = ?2",
        params![code, user_id],
    )?;
    tx.commit()?;
    Ok(LeaveRoomReply {
        code: code.to_owned(),
        notify: before,
    })
}

fn disband_room_impl(
    conn: &mut Connection,
    user_id: &str,
    code: &str,
) -> StoreResult<DisbandRoomReply> {
    let tx = conn.transaction()?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT owner_id FROM rooms WHERE code = ?1",
            params![code],
            |row| row.get(0),
        )
        .optional()?;
    let Some(owner) = owner else {
        return Err(StoreError::NotFound);
    };
    if owner != user_id {
        return Err(StoreError::Forbidden);
    }
    let before = member_ids(&tx, code)?;
    tx.execute("DELETE FROM rooms WHERE code = ?1", params![code])?;
    tx.commit()?;
    Ok(DisbandRoomReply {
        code: code.to_owned(),
        notify: before,
    })
}

#[allow(clippy::too_many_arguments)]
fn send_task_impl(
    conn: &mut Connection,
    from_user: &str,
    task_id: &str,
    room: &str,
    to_user: &str,
    env: &str,
    title: &str,
    brief: &str,
    now_ms: i64,
) -> StoreResult<SendTaskReply> {
    let tx = conn.transaction()?;
    let tombstoned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_tombstones WHERE task_id = ?1 AND expires_at > ?2)",
        params![task_id, now_ms],
        |row| row.get(0),
    )?;
    if tombstoned {
        return Err(StoreError::Conflict);
    }
    tx.execute(
        "DELETE FROM task_tombstones WHERE task_id = ?1 AND expires_at <= ?2",
        params![task_id, now_ms],
    )?;
    if let Some(existing) = task_row(&tx, task_id)? {
        if existing.expires_at <= now_ms {
            tx.execute("DELETE FROM tasks WHERE task_id = ?1", params![task_id])?;
        } else {
            if existing.from_user != from_user {
                return Err(StoreError::Conflict);
            }
            if existing.room != room
                || existing.to_user != to_user
                || existing.env != env
                || existing.title != title
                || existing.brief != brief
            {
                return Err(StoreError::Conflict);
            }
            let task = existing.summary();
            tx.commit()?;
            return Ok(SendTaskReply {
                task,
                created: false,
                notify: Vec::new(),
            });
        }
    }

    let from_name = member_name(&tx, room, from_user)?.ok_or(StoreError::Forbidden)?;
    if from_user == to_user {
        return Err(StoreError::Invalid);
    }
    let to_name = member_name(&tx, room, to_user)?.ok_or(StoreError::NotFound)?;
    if let Some(advertised) = tx
        .query_row(
            "SELECT environments FROM profiles WHERE user_id = ?1",
            params![to_user],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        let environments = decode_environments(&advertised);
        if !environments.is_empty() && !environments.iter().any(|entry| entry.key == env) {
            return Err(StoreError::Invalid);
        }
    }

    if related_task_count(&tx, from_user, now_ms)? >= MAX_RELATED_TASKS
        || related_task_count(&tx, to_user, now_ms)? >= MAX_RELATED_TASKS
    {
        return Err(StoreError::CapacityExceeded);
    }
    if pending_inbox_count(&tx, to_user, now_ms)? >= MAX_PENDING_INBOX {
        return Err(StoreError::CapacityExceeded);
    }

    let expires_at = now_ms + TASK_TTL_MS;
    tx.execute(
        "INSERT INTO tasks (task_id, room, from_user, from_name, to_user, to_name, env, title, \
         brief, status, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            task_id,
            room,
            from_user,
            from_name,
            to_user,
            to_name,
            env,
            title,
            brief,
            STATUS_PENDING,
            now_ms,
            expires_at
        ],
    )?;
    tx.commit()?;
    Ok(SendTaskReply {
        task: TaskSummary {
            task_id: task_id.to_owned(),
            room: room.to_owned(),
            from: Peer {
                user_id: from_user.to_owned(),
                display_name: from_name,
            },
            to: Peer {
                user_id: to_user.to_owned(),
                display_name: to_name,
            },
            env: env.to_owned(),
            title: title.to_owned(),
            status: STATUS_PENDING.to_owned(),
            from_visibility: "active".to_owned(),
            to_visibility: "active".to_owned(),
            created_at: now_ms,
            expires_at,
        },
        created: true,
        notify: vec![from_user.to_owned(), to_user.to_owned()],
    })
}

fn get_task_impl(
    conn: &mut Connection,
    user_id: &str,
    task_id: &str,
    now_ms: i64,
) -> StoreResult<GetTaskReply> {
    let row = task_row(conn, task_id)?.ok_or(StoreError::NotFound)?;
    if row.expires_at <= now_ms {
        return Err(StoreError::NotFound);
    }
    if row.from_user != user_id && row.to_user != user_id {
        return Err(StoreError::Forbidden);
    }
    if (row.from_user == user_id && row.from_visibility == "deleted")
        || (row.to_user == user_id && row.to_visibility == "deleted")
    {
        return Err(StoreError::NotFound);
    }
    let brief = row.brief.clone();
    Ok(GetTaskReply {
        task: row.summary(),
        brief,
    })
}

fn respond_task_impl(
    conn: &mut Connection,
    user_id: &str,
    task_id: &str,
    decision: &str,
    clock: impl FnOnce() -> i64,
) -> StoreResult<RespondTaskReply> {
    let tx = conn.transaction()?;
    let mut row = task_row(&tx, task_id)?.ok_or(StoreError::NotFound)?;
    if row.expires_at <= clock() {
        return Err(StoreError::NotFound);
    }
    if row.to_user != user_id {
        return Err(StoreError::Forbidden);
    }
    if row.to_visibility == "deleted" {
        return Err(StoreError::NotFound);
    }
    if row.status == decision {
        let task = row.summary();
        tx.commit()?;
        return Ok(RespondTaskReply {
            task,
            notify: Vec::new(),
        });
    }
    if row.status != STATUS_PENDING {
        return Err(StoreError::Conflict);
    }
    tx.execute(
        "UPDATE tasks SET status = ?1 WHERE task_id = ?2 AND status = ?3",
        params![decision, task_id, STATUS_PENDING],
    )?;
    row.status = decision.to_owned();
    let task = row.summary();
    tx.commit()?;
    Ok(RespondTaskReply {
        task,
        notify: vec![row.from_user, row.to_user],
    })
}

fn set_task_visibility_impl(
    conn: &mut Connection,
    user_id: &str,
    task_id: &str,
    visibility: &str,
    now_ms: i64,
) -> StoreResult<TaskVisibilityReply> {
    if !matches!(visibility, "active" | "archived" | "deleted") {
        return Err(StoreError::Invalid);
    }
    let tx = conn.transaction()?;
    let Some(mut row) = task_row(&tx, task_id)? else {
        if visibility != "deleted" {
            return Err(StoreError::NotFound);
        }
        tx.commit()?;
        return Ok(TaskVisibilityReply {
            task_id: task_id.to_owned(),
            purged: true,
            notify: Vec::new(),
        });
    };
    let (column, current) = if row.from_user == user_id {
        ("from_visibility", &mut row.from_visibility)
    } else if row.to_user == user_id {
        ("to_visibility", &mut row.to_visibility)
    } else {
        return Err(StoreError::Forbidden);
    };
    if row.expires_at <= now_ms {
        return Err(StoreError::NotFound);
    }
    if current == visibility {
        tx.commit()?;
        return Ok(TaskVisibilityReply {
            task_id: task_id.to_owned(),
            purged: false,
            notify: Vec::new(),
        });
    }
    if !matches!(
        (current.as_str(), visibility),
        ("active", "archived") | ("archived", "active") | ("archived", "deleted")
    ) {
        return Err(StoreError::Conflict);
    }
    *current = visibility.to_owned();
    let purged = row.from_visibility == "deleted" && row.to_visibility == "deleted";
    if purged {
        // Keep only the retry key until the original task's seven-day expiry.
        tx.execute(
            "INSERT INTO task_tombstones (task_id, expires_at) VALUES (?1, ?2)",
            params![task_id, row.expires_at],
        )?;
        tx.execute("DELETE FROM tasks WHERE task_id = ?1", params![task_id])?;
    } else {
        tx.execute(
            &format!("UPDATE tasks SET {column} = ?1 WHERE task_id = ?2"),
            params![visibility, task_id],
        )?;
    }
    tx.commit()?;
    Ok(TaskVisibilityReply {
        task_id: task_id.to_owned(),
        purged,
        notify: vec![row.from_user, row.to_user],
    })
}

fn room_view(conn: &Connection, code: &str) -> StoreResult<RoomView> {
    let (name, owner_id, created_at): (String, String, i64) = conn.query_row(
        "SELECT name, owner_id, created_at FROM rooms WHERE code = ?1",
        params![code],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let members = {
        let mut stmt = conn.prepare(
            "SELECT m.user_id, m.display_name, COALESCE(p.environments, '[]') \
             FROM members m LEFT JOIN profiles p ON p.user_id = m.user_id \
             WHERE m.room_code = ?1 ORDER BY m.joined_at, m.user_id",
        )?;
        let rows = stmt.query_map(params![code], |row| {
            Ok(MemberView {
                user_id: row.get(0)?,
                display_name: row.get(1)?,
                online: false,
                environments: decode_environments(&row.get::<_, String>(2)?),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(RoomView {
        code: code.to_owned(),
        name,
        owner_id,
        created_at,
        members,
    })
}

fn member_ids(conn: &Connection, code: &str) -> StoreResult<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT user_id FROM members WHERE room_code = ?1 ORDER BY joined_at, user_id")?;
    let rows = stmt.query_map(params![code], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn member_name(conn: &Connection, code: &str, user_id: &str) -> StoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT display_name FROM members WHERE room_code = ?1 AND user_id = ?2",
            params![code, user_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn peer_ids(conn: &Connection, user_id: &str) -> StoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT other.user_id FROM members mine \
         JOIN members other ON other.room_code = mine.room_code \
         WHERE mine.user_id = ?1 ORDER BY other.user_id",
    )?;
    let rows = stmt.query_map(params![user_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn related_task_count(conn: &Connection, user_id: &str, now_ms: i64) -> StoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE expires_at > ?1 \
         AND ((from_user = ?2 AND from_visibility != 'deleted') \
           OR (to_user = ?2 AND to_visibility != 'deleted'))",
        params![now_ms, user_id],
        |row| row.get(0),
    )?)
}

fn pending_inbox_count(conn: &Connection, user_id: &str, now_ms: i64) -> StoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE to_user = ?1 AND status = ?2 AND expires_at > ?3 \
         AND to_visibility != 'deleted'",
        params![user_id, STATUS_PENDING, now_ms],
        |row| row.get(0),
    )?)
}

fn task_row(conn: &Connection, task_id: &str) -> StoreResult<Option<TaskRow>> {
    let sql = format!("SELECT {TASK_SUMMARY_COLUMNS}, brief FROM tasks WHERE task_id = ?1");
    Ok(conn
        .query_row(&sql, params![task_id], task_row_from_row)
        .optional()?)
}

fn task_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskSummary> {
    Ok(TaskSummary {
        task_id: row.get(0)?,
        room: row.get(1)?,
        from: Peer {
            user_id: row.get(2)?,
            display_name: row.get(3)?,
        },
        to: Peer {
            user_id: row.get(4)?,
            display_name: row.get(5)?,
        },
        env: row.get(6)?,
        title: row.get(7)?,
        status: row.get(8)?,
        from_visibility: row.get(11)?,
        to_visibility: row.get(12)?,
        created_at: row.get(9)?,
        expires_at: row.get(10)?,
    })
}

fn task_row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        task_id: row.get(0)?,
        room: row.get(1)?,
        from_user: row.get(2)?,
        from_name: row.get(3)?,
        to_user: row.get(4)?,
        to_name: row.get(5)?,
        env: row.get(6)?,
        title: row.get(7)?,
        status: row.get(8)?,
        from_visibility: row.get(11)?,
        to_visibility: row.get(12)?,
        created_at: row.get(9)?,
        expires_at: row.get(10)?,
        brief: row.get(13)?,
    })
}

fn generate_room_code() -> String {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    (0..ROOM_CODE_LEN)
        .map(|_| {
            *ROOM_CODE_CHARSET
                .choose(&mut rng)
                .expect("charset is non-empty") as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{MAX_BRIEF_BYTES, STATUS_ACCEPTED, STATUS_DECLINED};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const T0: i64 = 1_700_000_000_000;

    struct TestDb {
        store: Option<Store>,
        path: PathBuf,
    }

    impl TestDb {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "baton-store-test-{}-{}-{}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let store = Store::open(&path).expect("open store");
            Self {
                store: Some(store),
                path,
            }
        }

        fn store(&self) -> &Store {
            self.store.as_ref().unwrap()
        }

        fn raw(&self) -> Connection {
            Connection::open(&self.path).expect("raw connection")
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            self.store.take();
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        }
    }

    fn uid(n: u32) -> String {
        format!("00000000-0000-0000-0000-{n:012x}")
    }

    fn tid(n: u32) -> String {
        format!("00000000-0000-0000-0000-{n:012x}")
    }

    async fn create_room(db: &TestDb, owner: &str, name: &str) -> String {
        db.store()
            .create_room(owner, owner, name, T0)
            .await
            .unwrap()
            .code
    }

    #[tokio::test]
    async fn visibility_is_per_party_and_purges_only_after_both_delete() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(901);
        db.store()
            .send_task(
                &owner,
                &task_id,
                &code,
                &member,
                "e",
                "title",
                "private brief",
                T0,
            )
            .await
            .unwrap();
        assert!(matches!(
            db.store()
                .set_task_visibility(&owner, &task_id, "deleted", T0)
                .await,
            Err(StoreError::Conflict)
        ));
        assert!(matches!(
            db.store()
                .set_task_visibility(&uid(3), &task_id, "archived", T0)
                .await,
            Err(StoreError::Forbidden)
        ));
        db.store().leave_room(&member, &code).await.unwrap();
        db.store().disband_room(&owner, &code).await.unwrap();
        let archived = db
            .store()
            .set_task_visibility(&owner, &task_id, "archived", T0)
            .await
            .unwrap();
        assert!(!archived.purged);
        assert_eq!(archived.notify, vec![owner.clone(), member.clone()]);
        let retry = db
            .store()
            .set_task_visibility(&owner, &task_id, "archived", T0)
            .await
            .unwrap();
        assert!(retry.notify.is_empty());
        let sender_tasks = db.store().sync(&owner, T0).await.unwrap().tasks;
        assert_eq!(sender_tasks[0].from_visibility, "archived");
        assert_eq!(sender_tasks[0].to_visibility, "active");
        db.store()
            .set_task_visibility(&owner, &task_id, "active", T0)
            .await
            .unwrap();
        db.store()
            .set_task_visibility(&owner, &task_id, "archived", T0)
            .await
            .unwrap();
        assert!(
            !db.store()
                .set_task_visibility(&owner, &task_id, "deleted", T0)
                .await
                .unwrap()
                .purged
        );
        assert!(db.store().sync(&owner, T0).await.unwrap().tasks.is_empty());
        assert!(matches!(
            db.store().get_task(&owner, &task_id, T0).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            db.store()
                .set_task_visibility(&owner, &task_id, "active", T0)
                .await,
            Err(StoreError::Conflict)
        ));
        assert_eq!(
            db.store()
                .get_task(&member, &task_id, T0)
                .await
                .unwrap()
                .brief,
            "private brief"
        );
        db.store()
            .set_task_visibility(&member, &task_id, "archived", T0)
            .await
            .unwrap();
        assert!(
            db.store()
                .set_task_visibility(&member, &task_id, "deleted", T0)
                .await
                .unwrap()
                .purged
        );
        let raw = db.raw();
        let count: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let tombstones: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM task_tombstones WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstones, 1);
        assert!(
            db.store()
                .set_task_visibility(&member, &task_id, "deleted", T0)
                .await
                .unwrap()
                .purged
        );
        assert!(matches!(
            db.store()
                .send_task(
                    &owner,
                    &task_id,
                    &code,
                    &member,
                    "e",
                    "title",
                    "private brief",
                    T0
                )
                .await,
            Err(StoreError::Conflict)
        ));
        db.store().delete_expired(T0 + TASK_TTL_MS).await.unwrap();
        let tombstones: i64 = raw
            .query_row("SELECT COUNT(*) FROM task_tombstones", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tombstones, 0);
    }

    #[tokio::test]
    async fn permanently_deleted_recipient_cannot_get_or_respond() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(902);
        db.store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "b", T0)
            .await
            .unwrap();
        db.store()
            .set_task_visibility(&member, &task_id, "archived", T0)
            .await
            .unwrap();
        db.store()
            .set_task_visibility(&member, &task_id, "deleted", T0)
            .await
            .unwrap();
        assert!(matches!(
            db.store().get_task(&member, &task_id, T0).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            db.store()
                .respond_task(&member, &task_id, STATUS_ACCEPTED, || T0)
                .await,
            Err(StoreError::NotFound)
        ));
        assert!(
            !db.store()
                .set_task_visibility(&member, &task_id, "deleted", T0)
                .await
                .unwrap()
                .purged
        );
        assert_eq!(db.store().sync(&owner, T0).await.unwrap().tasks.len(), 1);
    }

    #[tokio::test]
    async fn purge_is_atomic_and_reused_ids_do_not_keep_expired_tombstones() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(903);
        for now in [T0, T0 + TASK_TTL_MS] {
            db.store()
                .send_task(&owner, &task_id, &code, &member, "e", "t", "b", now)
                .await
                .unwrap();
            db.store()
                .set_task_visibility(&owner, &task_id, "archived", now)
                .await
                .unwrap();
            db.store()
                .set_task_visibility(&owner, &task_id, "deleted", now)
                .await
                .unwrap();
            db.store()
                .set_task_visibility(&member, &task_id, "archived", now)
                .await
                .unwrap();
            if now == T0 {
                let raw = db.raw();
                raw.execute_batch("CREATE TRIGGER reject_task_purge BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'test rollback'); END;").unwrap();
                assert!(matches!(
                    db.store()
                        .set_task_visibility(&member, &task_id, "deleted", now)
                        .await,
                    Err(StoreError::Internal(_))
                ));
                let retained = task_row(&raw, &task_id).unwrap().unwrap();
                assert_eq!(retained.to_visibility, "archived");
                assert_eq!(retained.brief, "b");
                let count: i64 = raw
                    .query_row("SELECT COUNT(*) FROM task_tombstones", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(count, 0);
                raw.execute_batch("DROP TRIGGER reject_task_purge").unwrap();
            }
            assert!(
                db.store()
                    .set_task_visibility(&member, &task_id, "deleted", now)
                    .await
                    .unwrap()
                    .purged
            );
        }
    }

    #[tokio::test]
    async fn room_capacity_idempotent_join_leave_and_disband() {
        let db = TestDb::new();
        let owner = uid(1);
        let created = db
            .store()
            .create_room(&owner, "Owner", "room", T0)
            .await
            .unwrap();
        let code = created.code.clone();
        assert_eq!(created.room.members.len(), 1);
        assert_eq!(created.notify, vec![owner.clone()]);

        let duplicate = db
            .store()
            .join_room(&owner, "Owner", &code, T0)
            .await
            .unwrap();
        assert!(!duplicate.created);
        assert!(duplicate.notify.is_empty());

        for n in 2..=10 {
            let user = uid(n);
            let joined = db.store().join_room(&user, &user, &code, T0).await.unwrap();
            assert!(joined.created);
            assert!(joined.notify.contains(&owner));
            assert!(joined.notify.contains(&user));
        }
        let overflow = db
            .store()
            .join_room(&uid(11), "Eleven", &code, T0)
            .await
            .unwrap_err();
        assert!(matches!(overflow, StoreError::CapacityExceeded));
        let still_ok = db
            .store()
            .join_room(&uid(2), "Two", &code, T0)
            .await
            .unwrap();
        assert!(!still_ok.created);

        assert!(matches!(
            db.store().leave_room(&owner, &code).await.unwrap_err(),
            StoreError::Forbidden
        ));
        let left = db.store().leave_room(&uid(3), &code).await.unwrap();
        assert_eq!(left.notify.len(), 10);
        let left_again = db.store().leave_room(&uid(3), &code).await.unwrap();
        assert!(left_again.notify.is_empty());
        let missing = db.store().leave_room(&uid(99), "ZZZZZZ").await.unwrap();
        assert!(missing.notify.is_empty());

        assert!(matches!(
            db.store().disband_room(&uid(2), &code).await.unwrap_err(),
            StoreError::Forbidden
        ));
        let disbanded = db.store().disband_room(&owner, &code).await.unwrap();
        assert_eq!(disbanded.notify.len(), 9);
        let raw = db.raw();
        let members: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM members WHERE room_code = ?1",
                params![code],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(members, 0, "disband must cascade");
        let rooms: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM rooms WHERE code = ?1",
                params![code],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rooms, 0);
        assert!(matches!(
            db.store().disband_room(&owner, &code).await.unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            db.store()
                .join_room(&uid(20), "Twenty", &code, T0)
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
    }

    #[tokio::test]
    async fn room_create_checks_ten_room_limit_in_transaction() {
        let db = TestDb::new();
        let owner = uid(1);
        for n in 0..10 {
            db.store()
                .create_room(&owner, "Owner", &format!("room-{n}"), T0)
                .await
                .unwrap();
        }
        assert!(matches!(
            db.store()
                .create_room(&owner, "Owner", "room-11", T0)
                .await
                .unwrap_err(),
            StoreError::CapacityExceeded
        ));
        let other = uid(2);
        db.store()
            .create_room(&other, "Other", "other-room", T0)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn room_join_enforces_user_limit_and_allows_retry_after_leaving() {
        let db = TestDb::new();
        let user = uid(1);
        let owner = uid(2);
        for n in 0..9 {
            create_room(&db, &user, &format!("owned-{n}")).await;
        }
        let joined_code = create_room(&db, &owner, "joined").await;
        let target_code = create_room(&db, &owner, "target").await;
        db.store()
            .join_room(&user, "User", &joined_code, T0)
            .await
            .unwrap();

        let duplicate = db
            .store()
            .join_room(&user, "User", &joined_code, T0)
            .await
            .unwrap();
        assert!(!duplicate.created);
        assert!(duplicate.notify.is_empty());

        let overflow = db.store().join_room(&user, "User", &target_code, T0).await;
        assert!(
            matches!(overflow, Err(StoreError::CapacityExceeded)),
            "an eleventh room must return an error without a notification reply: {overflow:?}"
        );
        assert_eq!(db.store().sync(&user, T0).await.unwrap().rooms.len(), 10);
        let inserted: i64 = db
            .raw()
            .query_row(
                "SELECT COUNT(*) FROM members WHERE room_code = ?1 AND user_id = ?2",
                params![target_code, user],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inserted, 0, "a rejected join must not insert membership");

        db.store().leave_room(&user, &joined_code).await.unwrap();
        let joined = db
            .store()
            .join_room(&user, "User", &target_code, T0)
            .await
            .unwrap();
        assert!(joined.created);
        assert!(joined.notify.contains(&user));
        assert!(joined.notify.contains(&owner));
        assert_eq!(db.store().sync(&user, T0).await.unwrap().rooms.len(), 10);
    }

    #[tokio::test]
    async fn hello_updates_names_and_notifies_room_peers() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "old").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();

        let changed = db.store().hello(&member, "B2", None).await.unwrap();
        assert!(changed.name_changed);
        assert_eq!(changed.peers, vec![owner.clone(), member.clone()]);
        let unchanged = db.store().hello(&member, "B2", None).await.unwrap();
        assert!(!unchanged.name_changed);
        assert_eq!(unchanged.peers.len(), 2);
        let sync = db.store().sync(&member, T0).await.unwrap();
        assert_eq!(sync.rooms[0].members[1].display_name, "B2");
    }

    #[tokio::test]
    async fn environments_are_advertised_without_paths() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();

        let frontend = EnvView {
            key: "frontend".into(),
            label: "前端".into(),
        };
        db.store()
            .hello(&member, "B", Some(vec![frontend.clone()]))
            .await
            .unwrap();
        let sync = db.store().sync(&owner, T0).await.unwrap();
        let advertised = &sync.rooms[0].members[1].environments;
        assert_eq!(advertised, &vec![frontend]);

        let backend = EnvView {
            key: "backend".into(),
            label: "后端".into(),
        };
        db.store()
            .set_environments(&member, vec![backend.clone()])
            .await
            .unwrap();
        let sync = db.store().sync(&owner, T0).await.unwrap();
        assert_eq!(&sync.rooms[0].members[1].environments, &vec![backend]);

        // A hello without the field must not erase an advertised list.
        db.store().hello(&member, "B", None).await.unwrap();
        let sync = db.store().sync(&owner, T0).await.unwrap();
        assert_eq!(sync.rooms[0].members[1].environments.len(), 1);
    }

    #[tokio::test]
    async fn task_env_must_be_in_the_recipient_advertised_list() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        db.store()
            .set_environments(
                &member,
                vec![EnvView {
                    key: "frontend".into(),
                    label: "前端".into(),
                }],
            )
            .await
            .unwrap();

        let mismatch = db
            .store()
            .send_task(&owner, &tid(200), &code, &member, "backend", "t", "b", T0)
            .await;
        assert!(matches!(mismatch, Err(StoreError::Invalid)));

        let accepted = db
            .store()
            .send_task(&owner, &tid(201), &code, &member, "frontend", "t", "b", T0)
            .await
            .unwrap();
        assert_eq!(accepted.task.env, "frontend");
    }

    #[tokio::test]
    async fn task_send_is_idempotent_per_field() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(100);
        let sent = db
            .store()
            .send_task(
                &owner, &task_id, &code, &member, "frontend", "title", "brief", T0,
            )
            .await
            .unwrap();
        assert!(sent.created);
        assert_eq!(sent.task.status, STATUS_PENDING);
        assert_eq!(sent.notify, vec![owner.clone(), member.clone()]);

        let again = db
            .store()
            .send_task(
                &owner, &task_id, &code, &member, "frontend", "title", "brief", T0,
            )
            .await
            .unwrap();
        assert!(!again.created);
        assert_eq!(again.task, sent.task);
        assert!(again.notify.is_empty());

        let variants = [
            ("ZZZZZZ", member.as_str(), "frontend", "title", "brief"),
            (code.as_str(), &uid(3), "frontend", "title", "brief"),
            (code.as_str(), member.as_str(), "backend", "title", "brief"),
            (code.as_str(), member.as_str(), "frontend", "other", "brief"),
            (code.as_str(), member.as_str(), "frontend", "title", "other"),
        ];
        for (room, to, env, title, brief) in variants {
            assert!(matches!(
                db.store()
                    .send_task(&owner, &task_id, room, to, env, title, brief, T0)
                    .await
                    .unwrap_err(),
                StoreError::Conflict
            ));
        }
        assert!(matches!(
            db.store()
                .send_task(
                    &uid(9),
                    &task_id,
                    &code,
                    &member,
                    "frontend",
                    "title",
                    "brief",
                    T0
                )
                .await
                .unwrap_err(),
            StoreError::Conflict
        ));

        let cross_room_target = uid(3);
        let other_code = create_room(&db, &owner, "other").await;
        db.store()
            .join_room(&cross_room_target, "C", &other_code, T0)
            .await
            .unwrap();
        assert!(matches!(
            db.store()
                .send_task(
                    &owner,
                    &tid(101),
                    &code,
                    &cross_room_target,
                    "e",
                    "t",
                    "b",
                    T0
                )
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            db.store()
                .send_task(&owner, &tid(102), &code, &owner, "e", "t", "b", T0)
                .await
                .unwrap_err(),
            StoreError::Invalid
        ));
    }

    #[tokio::test]
    async fn task_get_and_respond_permissions_and_idempotency() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let outsider = uid(3);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(200);
        db.store()
            .send_task(
                &owner, &task_id, &code, &member, "frontend", "title", "brief", T0,
            )
            .await
            .unwrap();

        let got = db.store().get_task(&member, &task_id, T0).await.unwrap();
        assert_eq!(got.brief, "brief");
        assert_eq!(got.task.from.display_name, owner);
        assert!(matches!(
            db.store()
                .get_task(&outsider, &task_id, T0)
                .await
                .unwrap_err(),
            StoreError::Forbidden
        ));
        assert!(matches!(
            db.store()
                .respond_task(&owner, &task_id, STATUS_ACCEPTED, || T0)
                .await
                .unwrap_err(),
            StoreError::Forbidden
        ));

        let accepted = db
            .store()
            .respond_task(&member, &task_id, STATUS_ACCEPTED, || T0)
            .await
            .unwrap();
        assert_eq!(accepted.task.status, STATUS_ACCEPTED);
        assert_eq!(accepted.notify, vec![owner.clone(), member.clone()]);
        let repeated = db
            .store()
            .respond_task(&member, &task_id, STATUS_ACCEPTED, || T0)
            .await
            .unwrap();
        assert_eq!(repeated.task.status, STATUS_ACCEPTED);
        assert!(repeated.notify.is_empty());
        assert!(matches!(
            db.store()
                .respond_task(&member, &task_id, STATUS_DECLINED, || T0)
                .await
                .unwrap_err(),
            StoreError::Conflict
        ));
        assert!(matches!(
            db.store()
                .respond_task(&uid(9), &task_id, STATUS_ACCEPTED, || T0)
                .await
                .unwrap_err(),
            StoreError::Forbidden
        ));
    }

    #[tokio::test]
    async fn approval_queued_before_expiry_is_rejected_after_expiry() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(299);
        db.store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "b", T0)
            .await
            .unwrap();
        let before = crate::protocol::now_ms();
        db.raw()
            .execute(
                "UPDATE tasks SET expires_at = ?1 WHERE task_id = ?2",
                params![before + 50, task_id],
            )
            .unwrap();
        let (release, blocked) = std::sync::mpsc::channel();
        db.store()
            .tx
            .send(Box::new(move |_| {
                blocked.recv().unwrap();
            }))
            .await
            .unwrap();
        let response =
            db.store()
                .respond_task(&member, &task_id, STATUS_ACCEPTED, crate::protocol::now_ms);
        let advance = async {
            tokio::time::sleep(Duration::from_millis(75)).await;
            release.send(()).unwrap();
        };
        let (result, _) = tokio::join!(response, advance);
        assert!(
            matches!(result, Err(StoreError::NotFound)),
            "approval must check expiry after leaving the queue: {result:?}"
        );
        let status: String = db
            .raw()
            .query_row(
                "SELECT status FROM tasks WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, STATUS_PENDING);
    }

    #[tokio::test]
    async fn expired_tasks_are_hidden_and_purged() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(300);
        let sent = db
            .store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "b", T0)
            .await
            .unwrap();
        assert_eq!(sent.task.expires_at, T0 + TASK_TTL_MS);

        let retried = db
            .store()
            .send_task(
                &owner,
                &task_id,
                &code,
                &member,
                "e",
                "t",
                "b",
                T0 + TASK_TTL_MS - 1,
            )
            .await
            .unwrap();
        assert_eq!(retried.task.expires_at, T0 + TASK_TTL_MS);

        let after = T0 + TASK_TTL_MS;
        assert!(matches!(
            db.store()
                .get_task(&member, &task_id, after)
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            db.store()
                .respond_task(&member, &task_id, STATUS_ACCEPTED, move || after)
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
        let sync = db.store().sync(&owner, after).await.unwrap();
        assert!(sync.tasks.is_empty());
        let deleted = db.store().delete_expired(after).await.unwrap();
        assert_eq!(deleted, 1);
        assert!(matches!(
            db.store()
                .get_task(&owner, &task_id, after)
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
    }

    #[tokio::test]
    async fn task_pending_inbox_limit() {
        let db = TestDb::new();
        let owner = uid(1);
        let first = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&first, "B", &code, T0).await.unwrap();
        for n in 0..MAX_PENDING_INBOX {
            db.store()
                .send_task(
                    &owner,
                    &tid(1000 + n as u32),
                    &code,
                    &first,
                    "e",
                    "t",
                    "b",
                    T0,
                )
                .await
                .unwrap();
        }
        assert!(matches!(
            db.store()
                .send_task(&owner, &tid(2000), &code, &first, "e", "t", "b", T0)
                .await
                .unwrap_err(),
            StoreError::CapacityExceeded
        ));
        let task_id = tid(1000);
        db.store()
            .set_task_visibility(&first, &task_id, "archived", T0)
            .await
            .unwrap();
        db.store()
            .set_task_visibility(&first, &task_id, "deleted", T0)
            .await
            .unwrap();
        db.store()
            .send_task(&owner, &tid(2000), &code, &first, "e", "t", "b", T0)
            .await
            .expect("deleting own pending item frees inbox capacity");
    }

    #[tokio::test]
    async fn task_related_limit_includes_terminal_tasks() {
        let db = TestDb::new();
        let owner = uid(1);
        let mut recipients = Vec::new();
        let mut rooms = Vec::new();
        for n in 0..4 {
            let room = create_room(&db, &owner, "room").await;
            let recipient = uid(200 + n);
            db.store()
                .join_room(&recipient, "R", &room, T0)
                .await
                .unwrap();
            recipients.push(recipient);
            rooms.push(room);
        }
        let mut task_no = 10_000;
        for (room, recipient) in rooms.iter().zip(&recipients) {
            for _ in 0..50 {
                let task_id = tid(task_no);
                task_no += 1;
                db.store()
                    .send_task(&owner, &task_id, room, recipient, "e", "t", "b", T0)
                    .await
                    .unwrap();
                db.store()
                    .respond_task(recipient, &task_id, STATUS_ACCEPTED, || T0)
                    .await
                    .unwrap();
            }
        }
        let fifth_room = create_room(&db, &owner, "room").await;
        let fifth = uid(301);
        db.store()
            .join_room(&fifth, "R", &fifth_room, T0)
            .await
            .unwrap();
        assert!(matches!(
            db.store()
                .send_task(&owner, &tid(20_000), &fifth_room, &fifth, "e", "t", "b", T0)
                .await
                .unwrap_err(),
            StoreError::CapacityExceeded
        ));
        let task_id = tid(10_000);
        db.store()
            .set_task_visibility(&owner, &task_id, "archived", T0)
            .await
            .unwrap();
        db.store()
            .set_task_visibility(&owner, &task_id, "deleted", T0)
            .await
            .unwrap();
        db.store()
            .send_task(&owner, &tid(20_000), &fifth_room, &fifth, "e", "t", "b", T0)
            .await
            .expect("deleting own outgoing item frees related capacity");
    }

    #[tokio::test]
    async fn sync_returns_rooms_and_tasks_without_expired_or_brief() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(400);
        db.store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "brief", T0)
            .await
            .unwrap();
        let sync = db.store().sync(&member, T0).await.unwrap();
        assert_eq!(sync.rooms.len(), 1);
        assert_eq!(sync.rooms[0].members.len(), 2);
        assert_eq!(sync.tasks.len(), 1);
        assert_eq!(sync.tasks[0].task_id, task_id);
        assert_eq!(sync.tasks[0].from.display_name, owner);
        let value = serde_json::to_value(&sync.tasks[0]).unwrap();
        assert!(value.get("brief").is_none());
        let unknown = uid(8);
        assert!(db
            .store()
            .sync(&unknown, T0)
            .await
            .unwrap()
            .rooms
            .is_empty());
    }

    #[tokio::test]
    async fn task_idempotent_retry_survives_leave_and_disband() {
        let db = TestDb::new();
        let owner = uid(1);
        let member = uid(2);
        let code = create_room(&db, &owner, "room").await;
        db.store().join_room(&member, "B", &code, T0).await.unwrap();
        let task_id = tid(500);
        let sent = db
            .store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "b", T0)
            .await
            .unwrap();

        db.store().disband_room(&owner, &code).await.unwrap();
        let retried = db
            .store()
            .send_task(&owner, &task_id, &code, &member, "e", "t", "b", T0)
            .await
            .unwrap();
        assert_eq!(retried.task, sent.task);
        assert!(!retried.created);
        let got = db.store().get_task(&member, &task_id, T0).await.unwrap();
        assert_eq!(got.task.room, code);
        let accepted = db
            .store()
            .respond_task(&member, &task_id, STATUS_ACCEPTED, || T0)
            .await
            .unwrap();
        assert_eq!(accepted.task.status, STATUS_ACCEPTED);
    }

    #[test]
    fn version_one_and_two_migrations_preserve_existing_data() {
        for source_version in [1_i64, 2_i64] {
            let path = std::env::temp_dir().join(format!(
                "baton-migrate-test-{}-{}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            {
                let conn = Connection::open(&path).unwrap();
                conn.execute_batch(
                "CREATE TABLE rooms (code TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);\
                 CREATE TABLE members (room_code TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (room_code, user_id), FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE);\
                 CREATE TABLE tasks (task_id TEXT PRIMARY KEY, room TEXT NOT NULL, from_user TEXT NOT NULL, from_name TEXT NOT NULL, to_user TEXT NOT NULL, to_name TEXT NOT NULL, env TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
            )
            .unwrap();
                conn.execute_batch(
                "INSERT INTO rooms VALUES ('ABCD23','Team','sender',1);\
                 INSERT INTO members VALUES ('ABCD23','sender','A',1);\
                 INSERT INTO tasks VALUES ('task','ABCD23','sender','A','recipient','B','e','title','private brief','pending',1,100);",
            ).unwrap();
                if source_version == 2 {
                    conn.execute_batch("CREATE TABLE profiles (user_id TEXT PRIMARY KEY, environments TEXT NOT NULL DEFAULT '[]');\
                    INSERT INTO profiles VALUES ('sender','[{\"key\":\"e\",\"label\":\"Environment\"}]');").unwrap();
                }
                conn.pragma_update(None, "user_version", source_version)
                    .unwrap();
            }
            let store = Store::open(&path).unwrap();
            drop(store);
            let conn = Connection::open(&path).unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, 3);
            let profiles: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(profiles, 1);
            let task = task_row(&conn, "task").unwrap().unwrap();
            assert_eq!(task.brief, "private brief");
            assert_eq!(task.from_visibility, "active");
            assert_eq!(task.to_visibility, "active");
            assert_eq!(
                member_name(&conn, "ABCD23", "sender").unwrap().as_deref(),
                Some("A")
            );
            if source_version == 2 {
                let environments: String = conn
                    .query_row(
                        "SELECT environments FROM profiles WHERE user_id = 'sender'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(decode_environments(&environments)[0].key, "e");
            }
            drop(conn);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(format!("{}-wal", path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", path.display()));
        }
    }

    #[test]
    fn higher_schema_version_is_refused() {
        let path = std::env::temp_dir().join(format!(
            "baton-schema-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 4_i64).unwrap();
        }
        match Store::open(&path) {
            Err(StoreError::UnsupportedSchema(version)) => assert_eq!(version, 4),
            Err(error) => panic!("unexpected error: {error}"),
            Ok(_) => panic!("higher schema version must fail startup"),
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn schema_and_foreign_keys_are_initialized() {
        let db = TestDb::new();
        let raw = db.raw();
        let version: i64 = raw
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let journal: String = raw
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal.to_ascii_lowercase(), "wal");
        let tables: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('rooms','members','profiles','tasks')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 4);
    }

    #[test]
    fn task_summary_serialization_has_expected_fields() {
        let summary = TaskSummary {
            task_id: tid(1),
            room: "ABCD23".into(),
            from: Peer {
                user_id: uid(1),
                display_name: "A".into(),
            },
            to: Peer {
                user_id: uid(2),
                display_name: "B".into(),
            },
            env: "e".into(),
            title: "t".into(),
            status: STATUS_PENDING.into(),
            from_visibility: "active".into(),
            to_visibility: "active".into(),
            created_at: T0,
            expires_at: T0 + TASK_TTL_MS,
        };
        let value = serde_json::to_value(summary).unwrap();
        assert_eq!(value["taskId"], tid(1));
        assert_eq!(value["expiresAt"], T0 + TASK_TTL_MS);
    }

    #[test]
    fn brief_limit_matches_protocol() {
        assert_eq!(MAX_BRIEF_BYTES, 8 * 1024);
    }

    #[test]
    fn generated_codes_use_the_restricted_charset() {
        for _ in 0..100 {
            let code = generate_room_code();
            assert_eq!(code.len(), ROOM_CODE_LEN);
            assert!(code.bytes().all(|b| ROOM_CODE_CHARSET.contains(&b)));
        }
    }
}
