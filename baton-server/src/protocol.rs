use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_BRIEF_BYTES: usize = 8 * 1024;
pub const ROOM_CODE_LEN: usize = 6;
pub const ROOM_CODE_CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const STATE_CHANGED_EVENT: &str = r#"{"type":"state.changed"}"#;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_ACCEPTED: &str = "accepted";
pub const STATUS_DECLINED: &str = "declined";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    AuthFailed,
    ProtocolMismatch,
    RateLimited,
    Forbidden,
    NotFound,
    Conflict,
    CapacityExceeded,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::AuthFailed => "auth_failed",
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::RateLimited => "rate_limited",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::CapacityExceeded => "capacity_exceeded",
            Self::Internal => "internal",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid request",
            Self::AuthFailed => "authentication failed",
            Self::ProtocolMismatch => "unsupported protocol version",
            Self::RateLimited => "rate limit exceeded",
            Self::Forbidden => "operation not permitted",
            Self::NotFound => "resource not found",
            Self::Conflict => "conflict",
            Self::CapacityExceeded => "capacity exceeded",
            Self::Internal => "internal error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub id: Option<String>,
    pub code: ErrorCode,
}

impl ProtocolError {
    fn invalid(id: Option<String>) -> Self {
        Self {
            id,
            code: ErrorCode::InvalidRequest,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accepted,
    Declined,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => STATUS_ACCEPTED,
            Self::Declined => STATUS_DECLINED,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    Hello {
        protocol_version: u64,
        secret: String,
        user_id: String,
        display_name: String,
    },
    Sync,
    RoomCreate {
        name: String,
    },
    RoomJoin {
        code: String,
    },
    RoomLeave {
        code: String,
    },
    RoomDisband {
        code: String,
    },
    TaskSend {
        task_id: String,
        room: String,
        to: String,
        env: String,
        title: String,
        brief: String,
    },
    TaskGet {
        task_id: String,
    },
    TaskRespond {
        task_id: String,
        decision: Decision,
    },
    Ping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub kind: RequestKind,
}

pub fn parse_request(text: &str) -> Result<Request, ProtocolError> {
    if text.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::invalid(None));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| ProtocolError::invalid(None))?;
    let obj = value
        .as_object()
        .ok_or_else(|| ProtocolError::invalid(None))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::invalid(None))?;
    let ty = required_str(obj, "type", &id)?;
    let data = obj.get("data");

    let kind = match ty {
        "hello" => {
            let data = required_object(data, &id)?;
            let version = data
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .ok_or_else(|| ProtocolError::invalid(Some(id.clone())))?;
            if version != PROTOCOL_VERSION {
                return Err(ProtocolError {
                    id: Some(id),
                    code: ErrorCode::ProtocolMismatch,
                });
            }
            let secret = required_str(data, "secret", &id)?;
            let user_id = uuid_field(data, "userId", &id)?;
            let display_name = name_field(data, "displayName", &id)?;
            RequestKind::Hello {
                protocol_version: version,
                secret: secret.to_owned(),
                user_id,
                display_name,
            }
        }
        "sync" => {
            empty_data(data, &id)?;
            RequestKind::Sync
        }
        "room.create" => {
            let data = required_object(data, &id)?;
            RequestKind::RoomCreate {
                name: name_field(data, "name", &id)?,
            }
        }
        "room.join" => {
            let data = required_object(data, &id)?;
            RequestKind::RoomJoin {
                code: code_field(data, "code", &id)?,
            }
        }
        "room.leave" => {
            let data = required_object(data, &id)?;
            RequestKind::RoomLeave {
                code: code_field(data, "code", &id)?,
            }
        }
        "room.disband" => {
            let data = required_object(data, &id)?;
            RequestKind::RoomDisband {
                code: code_field(data, "code", &id)?,
            }
        }
        "task.send" => {
            let data = required_object(data, &id)?;
            let task_id = uuid_field(data, "taskId", &id)?;
            let room = code_field(data, "room", &id)?;
            let to = uuid_field(data, "to", &id)?;
            let env = env_field(data, "env", &id)?;
            let title = title_field(data, "title", &id)?;
            let brief = brief_field(data, "brief", &id)?;
            RequestKind::TaskSend {
                task_id,
                room,
                to,
                env,
                title,
                brief,
            }
        }
        "task.get" => {
            let data = required_object(data, &id)?;
            RequestKind::TaskGet {
                task_id: uuid_field(data, "taskId", &id)?,
            }
        }
        "task.respond" => {
            let data = required_object(data, &id)?;
            let task_id = uuid_field(data, "taskId", &id)?;
            let decision = match required_str(data, "decision", &id)? {
                "accepted" => Decision::Accepted,
                "declined" => Decision::Declined,
                _ => return Err(ProtocolError::invalid(Some(id.clone()))),
            };
            RequestKind::TaskRespond { task_id, decision }
        }
        "ping" => {
            empty_data(data, &id)?;
            RequestKind::Ping
        }
        _ => return Err(ProtocolError::invalid(Some(id))),
    };

    Ok(Request { id, kind })
}

fn required_object<'a>(
    data: Option<&'a Value>,
    id: &str,
) -> Result<&'a Map<String, Value>, ProtocolError> {
    data.and_then(Value::as_object)
        .ok_or_else(|| ProtocolError::invalid(Some(id.to_owned())))
}

fn empty_data(data: Option<&Value>, id: &str) -> Result<(), ProtocolError> {
    match data {
        Some(Value::Object(_)) => Ok(()),
        _ => Err(ProtocolError::invalid(Some(id.to_owned()))),
    }
}

fn required_str<'a>(
    obj: &'a Map<String, Value>,
    field: &str,
    id: &str,
) -> Result<&'a str, ProtocolError> {
    obj.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::invalid(Some(id.to_owned())))
}

fn uuid_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    normalize_uuid(required_str(obj, field, id)?)
        .ok_or_else(|| ProtocolError::invalid(Some(id.to_owned())))
}

fn code_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    normalize_room_code(required_str(obj, field, id)?)
        .ok_or_else(|| ProtocolError::invalid(Some(id.to_owned())))
}

fn name_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    normalize_name(required_str(obj, field, id)?)
        .ok_or_else(|| ProtocolError::invalid(Some(id.to_owned())))
}

fn env_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    let value = required_str(obj, field, id)?;
    if is_valid_env(value) {
        Ok(value.to_owned())
    } else {
        Err(ProtocolError::invalid(Some(id.to_owned())))
    }
}

fn title_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    let value = required_str(obj, field, id)?;
    if is_valid_title(value) {
        Ok(value.to_owned())
    } else {
        Err(ProtocolError::invalid(Some(id.to_owned())))
    }
}

fn brief_field(obj: &Map<String, Value>, field: &str, id: &str) -> Result<String, ProtocolError> {
    let value = required_str(obj, field, id)?;
    if is_valid_brief(value) {
        Ok(value.to_owned())
    } else {
        Err(ProtocolError::invalid(Some(id.to_owned())))
    }
}

pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => *b == b'-',
        _ => b.is_ascii_hexdigit(),
    })
}

pub fn normalize_uuid(value: &str) -> Option<String> {
    if is_uuid(value) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

pub fn normalize_room_code(value: &str) -> Option<String> {
    let code = value.trim().to_ascii_uppercase();
    if code.len() == ROOM_CODE_LEN && code.bytes().all(|b| ROOM_CODE_CHARSET.contains(&b)) {
        Some(code)
    } else {
        None
    }
}

pub fn normalize_name(value: &str) -> Option<String> {
    let name = value.trim();
    let len = name.chars().count();
    if (1..=40).contains(&len) {
        Some(name.to_owned())
    } else {
        None
    }
}

pub fn is_valid_env(value: &str) -> bool {
    let len = value.len();
    (1..=64).contains(&len)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_valid_title(value: &str) -> bool {
    (1..=120).contains(&value.chars().count())
}

pub fn is_valid_brief(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_BRIEF_BYTES
}

pub fn ok_response(id: &str, data: Value) -> Value {
    json!({"id": id, "type": "ok", "data": data})
}

pub fn error_response(id: Option<&str>, code: ErrorCode) -> Value {
    json!({
        "id": id,
        "type": "error",
        "code": code.as_str(),
        "message": code.message(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub user_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub user_id: String,
    pub display_name: String,
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    pub code: String,
    pub name: String,
    pub owner_id: String,
    pub created_at: i64,
    pub members: Vec<MemberView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub room: String,
    pub from: Peer,
    pub to: Peer,
    pub env: String,
    pub title: String,
    pub status: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_A: &str = "00000000-0000-0000-0000-00000000000a";
    const UUID_B: &str = "00000000-0000-0000-0000-00000000000b";
    const UUID_T: &str = "00000000-0000-0000-0000-0000000000aa";

    fn parse(value: Value) -> Result<Request, ProtocolError> {
        parse_request(&value.to_string())
    }

    #[test]
    fn valid_hello_is_normalized() {
        let req = parse(json!({
            "id": "r1",
            "type": "hello",
            "data": {
                "protocolVersion": 1,
                "secret": "s".repeat(32),
                "userId": UUID_A.to_ascii_uppercase(),
                "displayName": "  Alice  "
            }
        }))
        .unwrap();
        assert_eq!(req.id, "r1");
        match req.kind {
            RequestKind::Hello {
                protocol_version,
                user_id,
                display_name,
                ..
            } => {
                assert_eq!(protocol_version, 1);
                assert_eq!(user_id, UUID_A);
                assert_eq!(display_name, "Alice");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn room_codes_are_trimmed_and_uppercased() {
        let req = parse(json!({
            "id": "r2",
            "type": "room.join",
            "data": {"code": " abcd23 "}
        }))
        .unwrap();
        assert_eq!(
            req.kind,
            RequestKind::RoomJoin {
                code: "ABCD23".into()
            }
        );
        for code in ["ABCDE0", "ABCDE1", "ABCDEI", "ABCDEO", "ABC", "ABCDE23X"] {
            let err = parse(json!({
                "id": "r3",
                "type": "room.leave",
                "data": {"code": code}
            }))
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidRequest);
        }
    }

    #[test]
    fn protocol_version_mismatch_is_distinct() {
        let err = parse(json!({
            "id": "r4",
            "type": "hello",
            "data": {
                "protocolVersion": 2,
                "secret": "s",
                "userId": UUID_A,
                "displayName": "A"
            }
        }))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProtocolMismatch);
        assert_eq!(err.id.as_deref(), Some("r4"));
    }

    #[test]
    fn field_rules_are_enforced() {
        let base = json!({
            "id": "r5",
            "type": "task.send",
            "data": {
                "taskId": UUID_T,
                "room": "ABCD23",
                "to": UUID_B,
                "env": "frontend",
                "title": "标题",
                "brief": "正文"
            }
        });
        assert!(parse(base.clone()).is_ok());

        let cases: Vec<(Value, ErrorCode)> = vec![
            (
                json!({"id":"r","type":"task.send","data":{"taskId":"not-a-uuid","room":"ABCD23","to":UUID_B,"env":"e","title":"t","brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":"bad","env":"e","title":"t","brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"","title":"t","brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"a b","title":"t","brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"e","title":"","brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"e","title":"x".repeat(121),"brief":"b"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"e","title":"t","brief":""}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.send","data":{"taskId":UUID_T,"room":"ABCD23","to":UUID_B,"env":"e","title":"t","brief":"x".repeat(MAX_BRIEF_BYTES + 1)}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"task.respond","data":{"taskId":UUID_T,"decision":"maybe"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"room.create","data":{"name":"   "}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"room.create","data":{"name":"x".repeat(41)}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"hello","data":{"protocolVersion":1,"secret":"s","userId":"bad","displayName":"A"}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"nope","data":{}}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"id":"r","type":"sync","data":[]}),
                ErrorCode::InvalidRequest,
            ),
        ];
        for (value, expected) in cases {
            assert_eq!(parse(value).unwrap_err().code, expected);
        }
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        for text in [
            "not json",
            "[]",
            r#"{"type":"sync","data":{}}"#,
            r#"{"id":"","type":"sync","data":{}}"#,
            r#"{"id":1,"type":"sync","data":{}}"#,
            r#"{"id":"r","data":{}}"#,
        ] {
            let err = parse_request(text).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidRequest);
        }
        let err = parse_request(r#"{"id":"r","data":{}}"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidRequest);
        assert_eq!(err.id.as_deref(), Some("r"));
    }

    #[test]
    fn trailing_input_is_not_accepted() {
        let err = parse_request(r#"{"id":"r","type":"sync","data":{}} trailing"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn request_above_frame_limit_is_rejected() {
        let text = format!(
            r#"{{"id":"r","type":"ping","data":{{}},"pad":"{}"}}"#,
            "x".repeat(MAX_REQUEST_BYTES)
        );
        let error = parse_request(&text).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn maximum_sync_payload_fits_response_limit() {
        let name = "名".repeat(40);
        let title = "标".repeat(120);
        let env = "e".repeat(64);
        let rooms = (0..10)
            .map(|room| RoomView {
                code: format!("ABCD{room:02}"),
                name: name.clone(),
                owner_id: UUID_A.into(),
                created_at: 1,
                members: (0..10)
                    .map(|member| MemberView {
                        user_id: format!("00000000-0000-0000-0000-{:012x}", member),
                        display_name: name.clone(),
                        online: true,
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let tasks = (0..200)
            .map(|task| TaskSummary {
                task_id: format!("00000000-0000-0000-0000-{:012x}", task),
                room: "ABCD23".into(),
                from: Peer {
                    user_id: UUID_A.into(),
                    display_name: name.clone(),
                },
                to: Peer {
                    user_id: UUID_B.into(),
                    display_name: name.clone(),
                },
                env: env.clone(),
                title: title.clone(),
                status: STATUS_PENDING.into(),
                created_at: 1,
                expires_at: 2,
            })
            .collect::<Vec<_>>();
        let text = serde_json::to_string(&json!({"rooms": rooms, "tasks": tasks})).unwrap();
        assert!(
            text.len() < MAX_RESPONSE_BYTES,
            "sync payload is {} bytes",
            text.len()
        );
    }

    #[test]
    fn serialized_shapes_match_contract() {
        let room = RoomView {
            code: "ABCD23".into(),
            name: "room".into(),
            owner_id: UUID_A.into(),
            created_at: 1,
            members: vec![MemberView {
                user_id: UUID_A.into(),
                display_name: "A".into(),
                online: true,
            }],
        };
        let value = serde_json::to_value(room).unwrap();
        assert_eq!(value["ownerId"], UUID_A);
        assert_eq!(value["createdAt"], 1);
        assert_eq!(value["members"][0]["userId"], UUID_A);
        assert_eq!(value["members"][0]["displayName"], "A");

        let task = TaskSummary {
            task_id: UUID_T.into(),
            room: "ABCD23".into(),
            from: Peer {
                user_id: UUID_A.into(),
                display_name: "A".into(),
            },
            to: Peer {
                user_id: UUID_B.into(),
                display_name: "B".into(),
            },
            env: "frontend".into(),
            title: "t".into(),
            status: STATUS_PENDING.into(),
            created_at: 1,
            expires_at: 2,
        };
        let value = serde_json::to_value(task).unwrap();
        assert_eq!(value["taskId"], UUID_T);
        assert_eq!(value["from"]["userId"], UUID_A);
        assert_eq!(value["to"]["displayName"], "B");
        assert_eq!(value["expiresAt"], 2);
    }
}
