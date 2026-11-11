/**
 * Baton inbox. All task text is rendered as text; approvals remain explicit UI actions.
 * CSS is scoped and installed with the plugin lifetime so the bundle needs no build.
 */
window.__ModuleLoader__.load({
  id: '@token-team/dsh-baton',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    const API = '/api/baton'
    const CSS = `
.bt-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:5px;background:#dcece3;color:#315c48;font-size:10px;font-weight:700}
.bt-panel-page{height:100%;min-height:600px;width:100%;min-width:0;flex:1 1 auto;align-self:stretch;display:flex;background:var(--dsw-alias-bg,transparent);overflow:hidden}
.bt-shell.bt-embedded{width:100%;height:100%;min-height:600px;max-height:none;flex:1 1 auto;align-self:stretch;border:0;border-radius:0;box-shadow:none;animation:none}
.bt-nav-icon{position:relative;display:flex;align-items:center;justify-content:center;flex:none}
.bt-nav-icon .bt-icon{width:100%;height:100%}
.bt-nav-badge{position:absolute;top:-4px;right:-5px;min-width:13px;height:13px;padding:0 3px;border-radius:7px;background:#315f4d;color:#fff;font-size:8px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1}
.bt-icon-button.copied,.bt-button.copied{color:#315c48;background:var(--bt-tint)}
.bt-combo{position:relative}
.bt-combo-menu{position:absolute;z-index:8;left:0;right:0;top:calc(100% + 4px);max-height:190px;overflow:auto;padding:4px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-bg);box-shadow:0 12px 30px rgb(12 30 21 / 14%)}
.bt-combo-option{display:flex;align-items:baseline;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-fg);text-align:left;font-size:12px}
.bt-combo-option:hover,.bt-combo-option.active{background:var(--bt-tint)}
.bt-combo-key{font-weight:650}
.bt-combo-label{color:var(--bt-muted);font-size:11px}
.bt-backdrop{position:fixed;inset:0;z-index:100;background:rgb(17 28 23 / 30%);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:36px;pointer-events:auto;animation:bt-fade .18s ease}
.bt-shell{--bt-bg:var(--dsw-alias-bg-elevated,#fff);--bt-fg:var(--dsw-alias-fg,#25372f);--bt-soft:color-mix(in srgb,var(--bt-bg) 96%,var(--bt-fg));--bt-muted:color-mix(in srgb,var(--bt-fg) 65%,var(--bt-bg));--bt-line:color-mix(in srgb,var(--bt-fg) 10%,var(--bt-bg));--bt-accent:color-mix(in srgb,#4f7e60 60%,var(--bt-fg));--bt-action:#315f4d;--bt-tint:color-mix(in srgb,#6da084 12%,var(--bt-bg));color:var(--bt-fg);background:var(--bt-bg);font-family:'Avenir Next','PingFang SC','Noto Sans SC',sans-serif;font-size:13px;line-height:1.5;width:min(1120px,100%);height:min(770px,calc(100dvh - 72px));min-height:360px;display:flex;flex-direction:column;border:1px solid var(--bt-line);border-radius:18px;box-shadow:0 36px 100px rgb(12 30 21 / 24%),0 2px 8px rgb(12 30 21 / 8%);overflow:hidden;isolation:isolate;animation:bt-enter .22s ease}
.bt-shell *{box-sizing:border-box}
.bt-shell button,.bt-shell input,.bt-shell select,.bt-shell textarea{font:inherit}
.bt-shell button{cursor:pointer}
.bt-shell button:disabled{cursor:not-allowed;opacity:.45}
.bt-shell button:focus-visible,.bt-shell input:focus-visible,.bt-shell select:focus-visible,.bt-shell textarea:focus-visible{outline:3px solid color-mix(in srgb,#72a88b 50%,transparent);outline-offset:3px}
.bt-shell button{transition:background .15s ease,color .15s ease,transform .15s ease}
.bt-shell button:active:not(:disabled){transform:translateY(1px)}
.bt-icon{width:17px;height:17px;flex:none;vertical-align:middle}
.bt-topbar{height:67px;min-height:67px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:0 25px;border-bottom:1px solid var(--bt-line)}
.bt-brand{display:flex;align-items:center;gap:11px}
.bt-mark{width:30px;height:30px;position:relative;display:block;flex:none}
.bt-mark:before,.bt-mark:after{content:'';position:absolute;width:9px;height:24px;background:#315f4d;border-radius:4px;transform:rotate(31deg)}
.bt-mark:before{left:5px;top:0}.bt-mark:after{left:17px;top:7px;background:#84a68e}
.bt-wordmark{font-size:18px;letter-spacing:-.7px;font-weight:750}
.bt-wordmark small{font-size:11px;font-weight:500;letter-spacing:1.4px;margin-left:10px;color:var(--bt-muted)}
.bt-top-actions{display:flex;align-items:center;gap:15px}
.bt-connection{font-size:11px;color:var(--bt-muted);display:flex;align-items:center;gap:6px}
.bt-dot{width:6px;height:6px;border-radius:50%;background:#a9ada9;flex:none}
.bt-dot.online{background:#639878;box-shadow:0 0 0 3px color-mix(in srgb,#83b393 13%,transparent)}
.bt-divider{height:17px;width:1px;background:var(--bt-line)}
.bt-icon-button{display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;color:var(--bt-muted);border-radius:7px;width:29px;height:29px;padding:0}
.bt-icon-button:hover{background:var(--bt-soft);color:var(--bt-fg)}
.bt-body{display:flex;flex:1;min-height:0}
.bt-sidebar{width:210px;flex:none;border-right:1px solid var(--bt-line);background:var(--bt-soft);display:flex;flex-direction:column;padding:24px 13px 12px}
.bt-nav-caption{font-size:10px;letter-spacing:1.6px;color:var(--bt-muted);font-weight:650;padding:0 12px;margin-bottom:12px}
.bt-nav{display:flex;align-items:center;gap:10px;width:100%;border:0;color:var(--bt-muted);background:transparent;padding:10px 12px;border-radius:8px;text-align:left;min-height:39px}
.bt-nav.active{background:var(--bt-tint);color:color-mix(in srgb,#537d65 65%,var(--bt-fg));font-weight:650}
.bt-nav .bt-count{margin-left:auto}
.bt-sidebar-heading{display:flex;align-items:center;justify-content:space-between;padding:26px 7px 8px 12px}
.bt-sidebar-heading span{font-size:11px;font-weight:650;color:var(--bt-muted)}
.bt-room-list{overflow:auto;flex:1;min-height:40px}
.bt-room-row{display:flex;align-items:center;border-radius:8px;margin:3px 0}
.bt-room-row.active{background:var(--bt-tint)}
.bt-room{display:flex;align-items:center;gap:9px;flex:1;min-width:0;border:0;background:transparent;color:var(--bt-fg);text-align:left;padding:10px 9px 10px 12px}
.bt-room-symbol{color:var(--bt-muted);font-size:16px;font-weight:400}
.bt-room-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.bt-room-meta{color:var(--bt-muted);font-size:10px;margin-top:2px;letter-spacing:.3px;font-variant-numeric:tabular-nums}
.bt-room-row>.bt-icon-button{margin-right:3px;opacity:0}.bt-room-row:hover>.bt-icon-button,.bt-room-row:focus-within>.bt-icon-button{opacity:1}
.bt-room-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 7px 15px}
.bt-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:35px;padding:7px 13px;border-radius:7px;border:1px solid var(--bt-line);background:var(--bt-bg);color:var(--bt-fg);font-size:12px;font-weight:550;white-space:nowrap}
.bt-button:hover:not(:disabled){background:var(--bt-soft)}
.bt-button.primary{background:var(--bt-action);border-color:var(--bt-action);color:#fff;box-shadow:0 2px 4px rgb(30 65 45 / 10%)}
.bt-button.primary:hover:not(:disabled){background:#264c3d}
.bt-button.ghost{background:transparent;border-color:transparent;color:var(--bt-muted)}
.bt-button.ghost.copied{background:var(--bt-tint);color:#315c48}
.bt-button.danger{color:#af4e42;border-color:color-mix(in srgb,#af4e42 20%,var(--bt-bg))}
.bt-button.full{width:100%}
.bt-profile{border-top:1px solid var(--bt-line);display:flex;align-items:center;gap:9px;padding:15px 9px 0}
.bt-avatar{width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none;background:var(--bt-tint);color:var(--bt-accent);font-size:12px;font-weight:650}
.bt-profile-name{font-size:11px;font-weight:650}.bt-profile-id{font:10px 'SFMono-Regular',Consolas,monospace;color:var(--bt-muted)}
.bt-workspace{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.bt-page-head{padding:23px 25px 0}
.bt-page-title-row{display:flex;justify-content:space-between;align-items:center;gap:16px}
.bt-page-title{font-size:21px;letter-spacing:-.7px;font-weight:650;margin:0}
.bt-page-subtitle{margin:5px 0 19px;color:var(--bt-muted);font-size:11px}
.bt-tabs{display:flex;gap:23px;border-bottom:1px solid var(--bt-line)}
.bt-tab{padding:0 0 12px;background:transparent;border:0;color:var(--bt-muted);position:relative;font-size:12px;display:flex;align-items:center;gap:6px}
.bt-tab.active{color:var(--bt-fg);font-weight:650}
.bt-tab.active:after{content:'';height:2px;position:absolute;bottom:-1px;left:0;right:0;background:var(--bt-accent);border-radius:2px}
.bt-tab .bt-count{background:var(--bt-soft);color:var(--bt-muted);height:16px;min-width:16px;font-size:9px}
.bt-message{margin:12px 24px 0;padding:10px 12px;display:flex;gap:8px;align-items:flex-start;border-radius:8px;background:color-mix(in srgb,#b38140 10%,var(--bt-bg));color:var(--bt-fg);font-size:11px}
.bt-message.error{background:color-mix(in srgb,#b65b4c 9%,var(--bt-bg))}
.bt-message.success{background:var(--bt-tint)}.bt-message>.bt-icon-button{margin-left:auto;margin-top:-4px;margin-right:-5px}
.bt-inbox{display:flex;flex:1;min-height:0;margin-top:0}
.bt-task-column{width:295px;flex:none;border-right:1px solid var(--bt-line);display:flex;flex-direction:column;min-height:0}
.bt-list-tools{display:flex;align-items:center;justify-content:space-between;padding:15px 14px 11px;gap:8px}
.bt-search{display:flex;align-items:center;gap:7px;padding:6px 8px;background:var(--bt-soft);border:1px solid transparent;border-radius:7px;min-width:0;flex:1}
.bt-search .bt-icon{width:13px;height:13px;color:var(--bt-muted)}
.bt-search input{min-width:0;width:100%;background:transparent;border:0;outline:0!important;color:var(--bt-fg);font-size:10px}
.bt-filter{border:0;background:transparent;color:var(--bt-muted);font-size:10px;padding:4px 0;flex:none}
.bt-task-list{overflow:auto;flex:1;padding:0 8px 10px;scrollbar-width:thin}
.bt-task{position:relative;border:1px solid transparent;border-radius:9px;width:100%;background:transparent;text-align:left;padding:13px 12px;margin-bottom:3px;color:var(--bt-fg)}
.bt-task:hover{background:var(--bt-soft)}
.bt-task.selected{background:var(--bt-tint);border-color:color-mix(in srgb,#6d9f7d 20%,var(--bt-bg))}
.bt-task-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.bt-person{display:flex;align-items:center;gap:7px;min-width:0;color:var(--bt-muted);font-size:10px}
.bt-person .bt-avatar{width:21px;height:21px;border-radius:7px;font-size:9px}
.bt-time{font-size:9px;color:var(--bt-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-task-title{font-size:12px;line-height:1.6;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 9px}
.bt-task-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-task{display:block;cursor:pointer;font:inherit}
.bt-task:focus-visible{outline:3px solid color-mix(in srgb,#72a88b 50%,transparent);outline-offset:-2px}
.bt-task-badges{display:flex;align-items:center;gap:6px;margin-left:auto}
.bt-task-link{border:0;background:transparent;color:var(--bt-muted);font-size:10px;padding:2px 0;border-bottom:1px dashed color-mix(in srgb,var(--bt-muted) 45%,transparent)}
.bt-task-link:hover{color:var(--bt-fg)}
.bt-task-link.deleted{color:color-mix(in srgb,#b65b4c 75%,var(--bt-fg));border-bottom:0}
.bt-env{display:flex;align-items:center;gap:4px;color:var(--bt-muted);font-size:9px}
.bt-env .bt-icon{width:12px;height:12px}
.bt-badge{display:inline-flex;align-items:center;gap:4px;border-radius:5px;padding:2px 6px;font-size:9px;line-height:1.6;white-space:nowrap;background:var(--bt-soft);color:var(--bt-muted);font-weight:500}
.bt-badge.pending{color:color-mix(in srgb,#a17a3f 65%,var(--bt-fg));background:color-mix(in srgb,#d1ad70 14%,var(--bt-bg))}
.bt-badge.accepted{color:var(--bt-accent);background:color-mix(in srgb,#83ae8d 13%,var(--bt-bg))}
.bt-badge.warning{color:color-mix(in srgb,#af7b3d 65%,var(--bt-fg));background:color-mix(in srgb,#cba16b 17%,var(--bt-bg))}
.bt-detail{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto}
.bt-detail-inner{padding:24px 26px 16px;flex:1}
.bt-detail-kicker{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--bt-muted);font-size:10px;margin-bottom:18px}
.bt-detail-title{margin:0;font-size:23px;font-weight:650;letter-spacing:-.65px;line-height:1.45;overflow-wrap:anywhere}
.bt-detail-person{display:flex;align-items:center;gap:9px;margin:17px 0 22px}
.bt-detail-person .bt-avatar{width:31px;height:31px}
.bt-detail-person strong{font-size:11px;font-weight:600}
.bt-detail-person small{display:block;color:var(--bt-muted);font-size:9px;margin-top:2px}
.bt-section-label{font-size:10px;font-weight:650;color:var(--bt-muted);letter-spacing:.3px;margin:23px 0 10px}
.bt-brief{font-size:12px;line-height:1.95;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--bt-fg)}
.bt-directory{background:var(--bt-soft);border:1px solid var(--bt-line);border-radius:9px;padding:12px 13px;margin:24px 0 0}
.bt-directory-head{display:flex;align-items:center;gap:6px;color:var(--bt-muted);font-size:10px;margin-bottom:7px}
.bt-path{font:10px/1.7 'SFMono-Regular',Consolas,monospace;overflow-wrap:anywhere;display:block}
.bt-hint{font-size:10px;line-height:1.8;color:var(--bt-muted);margin:9px 0 0}
.bt-warning{padding:12px 14px;border:1px solid color-mix(in srgb,#c18e4d 25%,var(--bt-bg));border-radius:8px;background:color-mix(in srgb,#d7b376 9%,var(--bt-bg));font-size:11px;line-height:1.8;margin-top:20px}
.bt-warning strong{display:block;font-weight:600;margin-bottom:4px}
.bt-detail-footer{padding:17px 26px 21px;border-top:1px solid var(--bt-line);background:var(--bt-bg);position:sticky;bottom:0}
.bt-detail-buttons{display:flex;gap:9px}.bt-detail-buttons>.primary{flex:1}.bt-detail-footer .bt-hint{font-size:9px;text-align:center;margin-top:9px}
.bt-empty{display:flex;flex:1;min-height:160px;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:35px;color:var(--bt-muted)}
.bt-empty-icon{width:53px;height:53px;border:1px solid var(--bt-line);background:var(--bt-soft);border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:15px}
.bt-empty-icon svg{width:23px;height:23px;color:#7b9b87}
.bt-empty strong{font-size:13px;color:var(--bt-fg);font-weight:550}.bt-empty p{font-size:11px;line-height:1.9;margin:7px 0 0;max-width:230px}
.bt-pending-send{margin:8px;padding:11px;border:1px dashed color-mix(in srgb,#c18e4d 35%,var(--bt-bg));border-radius:8px;font-size:10px;display:grid;gap:7px}
.bt-pending-send strong{font-size:11px}
.bt-dialog-cover{position:absolute;inset:0;z-index:10;background:rgb(17 28 23 / 24%);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(2px)}
.bt-dialog{width:min(475px,100%);max-height:100%;overflow:auto;background:var(--bt-bg);border:1px solid var(--bt-line);border-radius:13px;box-shadow:0 16px 70px rgb(12 30 21 / 20%)}
.bt-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;padding:22px 24px 0;gap:15px}
.bt-dialog-header h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.5px}
.bt-dialog-header p{color:var(--bt-muted);font-size:11px;line-height:1.8;margin:6px 0 0}
.bt-dialog-body{padding:20px 24px;display:grid;gap:15px}
.bt-field{display:grid;gap:7px;font-size:11px;font-weight:550}
.bt-field input,.bt-field select,.bt-field textarea{background:var(--bt-bg);border:1px solid var(--bt-line);border-radius:7px;min-height:37px;padding:8px 10px;color:var(--bt-fg);width:100%;min-width:0;font-size:12px;font-weight:400}
.bt-field textarea{resize:vertical;min-height:145px;line-height:1.8}
.bt-field small{font-size:9px;font-weight:400;color:var(--bt-muted)}
.bt-two-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bt-dialog-footer{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:15px 24px 20px;border-top:1px solid var(--bt-line)}
.bt-form-error{background:color-mix(in srgb,#b65b4c 9%,var(--bt-bg));border-radius:7px;padding:10px 12px;font-size:11px;color:var(--bt-fg);line-height:1.8}
.bt-room-member{display:flex;align-items:center;gap:10px;padding:9px 0}
.bt-room-member .bt-icon-button{margin-left:auto}
.bt-room-code{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;background:var(--bt-soft);border-radius:9px}
.bt-room-code code{font-size:21px;font-weight:600;letter-spacing:4px}
.bt-mobile-back{display:none}
.bt-spinner{animation:bt-spin .8s linear infinite}
@keyframes bt-fade{from{opacity:0}to{opacity:1}}
@keyframes bt-enter{from{opacity:0;transform:translateY(9px) scale(.992)}to{opacity:1;transform:none}}
@keyframes bt-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.bt-backdrop,.bt-shell,.bt-spinner{animation:none}.bt-shell button{transition:none}}
@media(max-width:1050px){.bt-backdrop{padding:22px}.bt-shell{height:calc(100dvh - 44px)}.bt-sidebar{width:176px}.bt-task-column{width:260px}.bt-detail-inner{padding:20px}.bt-detail-footer{padding:16px 20px}.bt-page-head{padding:20px 20px 0}}
@media(max-width:780px){.bt-backdrop{padding:12px}.bt-shell{height:calc(100dvh - 24px);border-radius:12px}.bt-sidebar{width:150px;padding-left:7px;padding-right:7px}.bt-task-column{width:220px}.bt-page-subtitle{max-width:200px}.bt-detail-title{font-size:20px}.bt-wordmark small{display:none}.bt-page-title{font-size:18px}}
@media(max-width:650px){.bt-topbar{height:58px;min-height:58px;padding:0 16px}.bt-sidebar{display:none}.bt-page-head{padding:17px 16px 0}.bt-page-subtitle{max-width:none;font-size:10px}.bt-page-title-row{gap:8px}.bt-page-title-row>.bt-button{padding:7px 10px}.bt-task-column{width:100%;border-right:0}.bt-detail{display:none}.bt-inbox.has-selection .bt-task-column{display:none}.bt-inbox.has-selection .bt-detail{display:flex}.bt-mobile-back{display:inline-flex}.bt-detail-inner{padding:16px 22px}.bt-detail-footer{padding:15px 22px}.bt-dialog-cover{padding:14px}.bt-dialog-body{padding:16px 20px}.bt-dialog-header{padding:20px 20px 0}.bt-dialog-footer{padding:15px 20px}.bt-two-fields{grid-template-columns:1fr}.bt-message{margin:10px 16px 0}}
`

    const paths = {
      inbox: ['M4 4h16v16H4z', 'M4 12h4l2 3h4l2-3h4'],
      arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
      back: ['M19 12H5', 'm11 6-6 6 6 6'],
      close: ['m6 6 12 12', 'M18 6 6 18'],
      plus: ['M12 5v14', 'M5 12h14'],
      copy: ['M9 9h11v11H9z', 'M15 5V3H3v12h2'],
      search: ['M20 20l-5-5', 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14'],
      folder: ['M3 6h6l2 2h10v12H3z'],
      clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5l3 2'],
      check: ['m5 12 4 4L19 6'],
      warning: ['m12 3 10 18H2z', 'M12 9v4', 'M12 16h.01'],
      send: ['m22 2-7 20-4-9-9-4z', 'M22 2 11 13'],
      people: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
      refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6 7a7 7 0 0 1 11-2l3 3', 'M18 17a7 7 0 0 1-11 2l-3-3'],
      dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    }
    function Icon({ name, spin = false }) {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.55, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'bt-icon' + (spin ? ' bt-spinner' : ''), 'aria-hidden': true }, (paths[name] ?? paths.inbox).map((d, index) => h('path', { key: index, d })))
    }

    let opened = false
    const listeners = new Set()
    const setOpen = value => { opened = value; for (const listener of listeners) listener() }
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    const openSnapshot = () => opened

    let attentionCount = 0
    const countListeners = new Set()
    const setAttentionCount = value => {
      const next = Math.max(0, Number(value) || 0)
      if (next === attentionCount) return
      attentionCount = next
      for (const listener of countListeners) listener()
    }
    const subscribeCount = listener => { countListeners.add(listener); return () => countListeners.delete(listener) }
    const countSnapshot = () => attentionCount

    let openSession = () => { throw new Error('会话导航服务尚未就绪。') }

    async function call(body) {
      let response
      try { response = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
      catch {
        const error = new Error('连接中断，操作结果暂未确认。请检查后重试。')
        error.data = { ok: false, code: 'connection-closed', error: error.message }
        throw error
      }
      const data = await response.json().catch(() => ({ ok: false, code: 'internal', error: '服务响应不完整，操作结果暂未确认。' }))
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
        const error = new Error('服务响应不完整，操作结果暂未确认。')
        error.data = { ok: false, code: 'internal', error: error.message }
        throw error
      }
      if (!response.ok || data.ok === false) {
        const error = new Error(data.error ?? '操作未完成，请稍后重试。')
        error.data = { ...data, ok: false, code: data.code ?? 'internal' }
        throw error
      }
      return data
    }

    function useFocusTrap(ref, active, close) {
      const closeRef = useRef(close)
      closeRef.current = close
      useEffect(() => {
        if (!active || !ref.current) return undefined
        const previous = document.activeElement
        const node = ref.current
        const focusable = () => Array.from(node.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(element => element.getClientRects().length)
        const first = focusable()[0]
        first?.focus()
        const onKey = event => {
          if (event.key !== 'Tab') return
          const items = focusable()
          if (!items.length) { event.preventDefault(); return }
          const index = items.indexOf(document.activeElement)
          if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1).focus() }
          else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus() }
        }
        node.addEventListener('keydown', onKey)
        return () => { node.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
      }, [ref, active])
      // React bubbling lets a nested menu consume Escape before its dialog does.
      return event => {
        if (active && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
      }
    }

    function Button({ children, icon, tone = '', busy, ...props }) {
      return h('button', { type: 'button', ...props, className: 'bt-button ' + tone }, [busy ? h(Icon, { key: 'i', name: 'refresh', spin: true }) : icon ? h(Icon, { key: 'i', name: icon }) : null, children])
    }
    function IconButton({ label, icon, ...props }) {
      return h('button', { type: 'button', title: label, 'aria-label': label, ...props, className: 'bt-icon-button' }, h(Icon, { name: icon }))
    }

    function CopyButton({ value, label, icon = 'copy', children, tone = '', ...props }) {
      const [done, setDone] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => clearTimeout(timer.current), [])
      async function onCopy(event) {
        event.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setDone(false), 1600)
        } catch {
          setDone(false)
        }
      }
      if (children) {
        return h('button', { type: 'button', ...props, title: done ? '已复制' : label, 'aria-label': done ? '已复制' : label, className: 'bt-button ' + tone + (done ? ' copied' : ''), onClick: onCopy }, [h(Icon, { key: 'i', name: done ? 'check' : icon }), done ? '已复制' : children])
      }
      return h('button', { type: 'button', title: done ? '已复制' : label, 'aria-label': done ? '已复制' : label, ...props, className: 'bt-icon-button' + (done ? ' copied' : ''), onClick: onCopy }, h(Icon, { name: done ? 'check' : icon }))
    }
    function Avatar({ name }) { return h('span', { className: 'bt-avatar', 'aria-hidden': true }, Array.from(name ?? '?').slice(0, 1).join('')) }
    function Field({ label, hint, children }) { return h('label', { className: 'bt-field' }, [h('span', { key: 'l' }, label), React.isValidElement(children) ? React.cloneElement(children, { key: 'control' }) : children, hint ? h('small', { key: 'h' }, hint) : null]) }
    function Empty({ title, description, icon = 'inbox' }) {
      return h('div', { className: 'bt-empty' }, [h('div', { key: 'i', className: 'bt-empty-icon' }, h(Icon, { name: icon })), h('strong', { key: 't' }, title), h('p', { key: 'd' }, description)])
    }
    function relative(time) {
      const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000))
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前'
      return Math.floor(minutes / 1440) + ' 天前'
    }
    function statusFor(task, record, incoming) {
      if (incoming && record?.phase === 'needs-review') return { text: '需核对', tone: 'warning' }
      if (incoming && task.status === 'accepted' && record?.phase === 'unsubmitted') return { text: '待启动', tone: 'warning' }
      if (incoming && record?.phase === 'submitted') return { text: '已提交', tone: 'accepted' }
      if (incoming && record?.phase === 'handled') return { text: '已自行处理', tone: '' }
      return task.status === 'pending' ? { text: incoming ? '待你确认' : '等待接手', tone: 'pending' } : task.status === 'accepted' ? { text: '已接手', tone: 'accepted' } : { text: '已拒绝', tone: '' }
    }
    function Badge({ value }) { return h('span', { className: 'bt-badge ' + value.tone }, value.text) }
    function newDraft(room = '') { return { taskId: crypto.randomUUID(), room, to: '', env: '', title: '', brief: '' } }

    function Dialog({ title, description, children, footer, close }) {
      const ref = useRef(null)
      const onKeyDown = useFocusTrap(ref, true, close)
      return h('div', { className: 'bt-dialog-cover', onMouseDown: event => { if (event.target === event.currentTarget) close() } }, h('section', { ref, onKeyDown, className: 'bt-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title }, [
        h('header', { key: 'h', className: 'bt-dialog-header' }, [h('div', { key: 't' }, [h('h2', { key: 'title' }, title), description ? h('p', { key: 'd' }, description) : null]), h(IconButton, { key: 'x', label: '关闭对话框', icon: 'close', onClick: close })]),
        h('div', { key: 'b', className: 'bt-dialog-body' }, children),
        h('footer', { key: 'f', className: 'bt-dialog-footer' }, footer),
      ]))
    }

    function SidebarBatonIcon({ size = 18, active = false }) {
      const attention = useSyncExternalStore(subscribeCount, countSnapshot)
      useEffect(() => {
        if (active) return undefined
        let mounted = true
        let timer
        async function poll() {
          try {
            const result = await call({ action: 'counts' })
            if (mounted) setAttentionCount(result.attention)
          } catch {}
          if (mounted) timer = setTimeout(poll, 15000)
        }
        poll()
        return () => { mounted = false; clearTimeout(timer) }
      }, [active])
      return h('span', {
        className: 'bt-nav-icon', style: { width: size, height: size },
        title: attention > 0 ? attention + ' 条待处理' : '接力',
        'aria-hidden': true,
      }, [
        h(Icon, { key: 'i', name: 'inbox' }),
        attention > 0 ? h('span', { key: 'b', className: 'bt-nav-badge' }, attention > 9 ? '9+' : attention) : null,
      ])
    }

    class PanelBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error) { console.error('baton panel crashed', error) }
      render() {
        if (this.state.error) return h('div', { style: { padding: 24, color: '#b42318', fontSize: 13 } }, 'Baton 面板加载失败：' + (this.state.error?.message ?? '未知错误'))
        return this.props.children
      }
    }

    function MainPanel() { return h(PanelBoundary, null, h(Panel, { embedded: true })) }

    function EnvPicker({ value, options, disabled, onChange }) {
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(-1)
      const ref = useRef(null)
      const selected = options.some(option => option.key === value)
      const query = value && !selected ? value.toLowerCase() : ''
      const filtered = options.filter(option => !query || option.key.toLowerCase().includes(query) || String(option.label ?? '').toLowerCase().includes(query))
      useEffect(() => {
        if (!open) return undefined
        const close = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [open])
      const choose = key => { onChange(key); setOpen(false); setActive(-1) }
      return h('div', { ref, className: 'bt-combo', onKeyDown: event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          ref.current?.querySelector('input')?.focus()
          setOpen(false)
          setActive(-1)
        }
      } }, [
        h('input', {
          key: 'input', role: 'combobox', 'aria-expanded': open, 'aria-controls': 'bt-env-options',
          value, maxLength: 64, disabled, placeholder: 'frontend',
          onFocus: () => { if (!disabled && !value) setOpen(true) },
          onClick: () => { if (!disabled) setOpen(true) },
          onChange: event => { onChange(event.target.value); setOpen(true); setActive(-1) },
          onKeyDown: event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(filtered.length - 1, index + 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(-1, index - 1)) }
            else if (event.key === 'Enter' && open && active >= 0 && filtered[active]) { event.preventDefault(); choose(filtered[active].key) }
          },
        }),
        open && filtered.length ? h('div', { key: 'menu', className: 'bt-combo-menu', id: 'bt-env-options', role: 'listbox' }, filtered.map((option, index) => h('button', {
          key: option.key, type: 'button', role: 'option', 'aria-selected': option.key === value,
          className: 'bt-combo-option' + (index === active ? ' active' : ''),
          onMouseDown: event => event.preventDefault(),
          onClick: () => choose(option.key),
        }, [
          h('span', { key: 'k', className: 'bt-combo-key' }, option.key),
          option.label && option.label !== option.key ? h('span', { key: 'l', className: 'bt-combo-label' }, option.label) : null,
        ]))) : null,
      ])
    }

    function Panel({ embedded = false } = {}) {
      const isOpen = useSyncExternalStore(subscribe, openSnapshot)
      const active = embedded || isOpen
      const [data, setData] = useState(null)
      const [tab, setTab] = useState('incoming')
      const [roomCode, setRoomCode] = useState('')
      const [query, setQuery] = useState('')
      const [onlyAttention, setOnlyAttention] = useState(false)
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [modal, setModal] = useState(null)
      const [roomInput, setRoomInput] = useState('')
      const [draft, setDraft] = useState(newDraft)
      const [draftError, setDraftError] = useState('')
      const [uncertain, setUncertain] = useState(false)
      const [missingSessions, setMissingSessions] = useState({})
      const ref = useRef(null)
      const busyRef = useRef(false)
      const refreshSequence = useRef(0)
      const detailSequence = useRef(0)
      const selectedRef = useRef(selected)
      selectedRef.current = selected
      const onKeyDown = useFocusTrap(ref, embedded ? false : (isOpen && !modal), () => setOpen(false))

      const refresh = useCallback(async () => {
        const sequence = ++refreshSequence.current
        try {
          const next = await call({ action: 'snapshot' })
          if (sequence === refreshSequence.current) setData(next)
        } catch (error) {
          if (sequence === refreshSequence.current) setNotice({ tone: 'error', message: error.message })
        }
      }, [])

      useEffect(() => {
        if (!active) return undefined
        let timer
        let mounted = true
        async function poll() { await refresh(); if (mounted) timer = setTimeout(poll, 5000) }
        poll()
        return () => { mounted = false; clearTimeout(timer) }
      }, [active, refresh])

      const online = data?.connection?.state === 'online'
      const rooms = data?.rooms ?? []
      const allTasks = data?.tasks ?? []
      const local = data?.local ?? {}
      const room = rooms.find(item => item.code === roomCode)
      const incoming = allTasks.filter(task => task.to.userId === data?.userId)
      const outgoing = allTasks.filter(task => task.from.userId === data?.userId)
      const attention = task => task.status === 'pending' || task.status === 'accepted' && ['unsubmitted', 'needs-review'].includes(local[task.taskId]?.phase ?? 'needs-review')
      const unread = incoming.filter(attention).length
      useEffect(() => { setAttentionCount(unread) }, [unread])
      const rows = (tab === 'incoming' ? incoming : outgoing).filter(task => !roomCode || task.room === roomCode).filter(task => !onlyAttention || (tab === 'incoming' ? attention(task) : task.status === 'pending')).filter(task => [task.title, task.from.displayName, task.to.displayName].some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase()))).sort((a, b) => b.createdAt - a.createdAt)
      const task = allTasks.find(item => item.taskId === selected)
      const record = local[selected] ?? detail?.local
      const mine = task?.to.userId === data?.userId
      const connectionText = online ? '已连接' : ['connecting', 'authenticating', 'reconnecting'].includes(data?.connection?.state) ? '正在连接' : data ? '未连接' : '连接中'
      const modalClose = () => { if (!busyRef.current) { setModal(null); setRoomInput('') } }

      async function revealSession(sessionId) {
        try {
          await openSession(sessionId)
          setOpen(false)
        } catch {
          setNotice({ tone: 'error', message: '会话已保留，暂时无法打开。请稍后点击“定位会话”重试。' })
        }
      }

      async function locateSession(sessionId) {
        if (missingSessions[sessionId]) { setNotice({ tone: 'error', message: '会话已删除，无法定位。' }); return }
        try {
          const result = await call({ action: 'session', sessionId })
          if (!result.exists) {
            setMissingSessions(previous => ({ ...previous, [sessionId]: true }))
            setNotice({ tone: 'error', message: '会话已删除，无法定位。' })
            return
          }
          await revealSession(sessionId)
        } catch (error) {
          setNotice({ tone: 'error', message: error.message })
        }
      }

      async function loadDetail(id) {
        const sequence = ++detailSequence.current
        setDetailBusy(true)
        try {
          const next = await call({ action: 'detail', taskId: id })
          if (sequence === detailSequence.current && selectedRef.current === id) setDetail(next)
        } catch (error) {
          if (sequence === detailSequence.current && selectedRef.current === id) { setDetail(null); setNotice({ tone: 'error', message: error.message }) }
        } finally { if (sequence === detailSequence.current) setDetailBusy(false) }
      }
      function selectTask(id) {
        selectedRef.current = id
        setSelected(id)
        setDetail(null)
        loadDetail(id)
      }
      async function run(body) {
        if (busyRef.current) return { ok: false }
        busyRef.current = true
        setBusy(body.action)
        try {
          const result = await call(body)
          await refresh()
          if (result.record) setData(previous => previous ? { ...previous, local: { ...previous.local, [body.taskId]: result.record } } : previous)
          return result
        } catch (error) {
          setNotice({ tone: 'error', message: error.message })
          if (error.data?.code === 'cwd-changed' && body.taskId && selectedRef.current === body.taskId) await loadDetail(body.taskId)
          await refresh()
          return { ...error.data, ok: false, error: error.message }
        } finally {
          busyRef.current = false
          setBusy('')
        }
      }
      async function submitDraft() {
        if (busyRef.current) return
        const result = await run({ action: 'send', ...draft })
        if (result.ok) {
          setDraft(newDraft(roomCode))
          setUncertain(false)
          setDraftError('')
          setModal(null)
          setTab('outgoing')
          setNotice({ tone: 'success', message: '接力已送出，等待对方确认。' })
        } else {
          const unknown = Boolean(result.taskId) || ['timeout', 'internal', 'connection-closed'].includes(result.code)
          setUncertain(unknown)
          setDraftError(unknown ? '投递结果暂未确认。内容已保留，重试会使用同一个任务标识。' : result.error ?? '发送未完成，内容已保留。')
        }
      }
      function updateDraft(field, value) {
        if (busyRef.current || uncertain) return
        setDraft(previous => ({ ...previous, [field]: value, ...(field === 'room' ? { to: '' } : {}), taskId: uncertain ? previous.taskId : crypto.randomUUID() }))
        if (!uncertain) setDraftError('')
      }
      function separateDraft() {
        if (busyRef.current) return
        setDraft(newDraft(rooms.some(item => item.code === roomCode) ? roomCode : ''))
        setUncertain(false)
        setDraftError('')
        setNotice({ tone: 'success', message: '原投递记录已保留，可在“已发出的”中继续确认。当前是独立的新任务。' })
      }
      function switchTab(value) { setTab(value); setSelected(null); setDetail(null); setOnlyAttention(false) }
      function confirm(kind, item) { setModal({ kind, task: item }) }
      async function finishStart(result) {
        const sessionId = result.sessionId ?? result.record?.sessionId
        if (sessionId) await revealSession(sessionId)
        else setNotice({ tone: 'success', message: '任务已接手，消息已提交到新的 DSH 会话。' })
      }
      async function approve() {
        const result = await run({ action: 'accept', taskId: task.taskId, cwd: detail.cwd })
        if (result.ok) await finishStart(result)
      }
      async function retrySendTask(item) {
        const result = await run({ action: 'retry-send', taskId: item.taskId })
        if (!result.ok) return
        if (draft.taskId === item.taskId) { setDraft(newDraft(roomCode)); setUncertain(false); setDraftError('') }
        setNotice({ tone: 'success', message: '投递已确认。' })
      }

      if (!active) return null

      const renderTask = item => {
        const inbound = tab === 'incoming'
        const person = inbound ? item.from : item.to
        const sessionId = local[item.taskId]?.sessionId
        const sessionAction = sessionId
          ? missingSessions[sessionId]
            ? h('span', { key: 'locate', className: 'bt-task-link deleted' }, '会话已删除')
            : h('button', { key: 'locate', type: 'button', className: 'bt-task-link', onClick: event => { event.stopPropagation(); locateSession(sessionId) } }, '定位会话')
          : null
        return h('div', {
          key: item.taskId, role: 'button', tabIndex: 0,
          className: 'bt-task' + (selected === item.taskId ? ' selected' : ''),
          'aria-pressed': selected === item.taskId,
          onClick: () => selectTask(item.taskId),
          onKeyDown: event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTask(item.taskId) } },
        }, [
          h('div', { key: 'top', className: 'bt-task-top' }, [h('span', { key: 'p', className: 'bt-person' }, [h(Avatar, { key: 'a', name: person.displayName }), person.displayName]), h('time', { key: 'time', className: 'bt-time', dateTime: new Date(item.createdAt).toISOString() }, relative(item.createdAt))]),
          h('div', { key: 'title', className: 'bt-task-title' }, item.title),
          h('div', { key: 'bottom', className: 'bt-task-bottom' }, [h('span', { key: 'env', className: 'bt-env' }, [h(Icon, { key: 'i', name: 'folder' }), item.env]), h('div', { key: 'badges', className: 'bt-task-badges' }, [sessionAction, h(Badge, { key: 'status', value: statusFor(item, local[item.taskId], inbound) })])]),
        ])
      }

      const renderDetail = () => {
        if (!task) return h(Empty, { title: '选择一条接力任务', description: '查看任务说明与执行目录，确认后再开始。' })
        const person = mine ? task.from : task.to
        const canAccept = mine && task.status === 'pending'
        let footerAction
        if (canAccept) {
          footerAction = h('div', { key: 'actions', className: 'bt-detail-buttons' }, [
            h(Button, { key: 'reject', disabled: !!busy || !online, onClick: () => confirm('decline', task) }, '拒绝'),
            h(Button, { key: 'accept', tone: 'primary', icon: 'arrow', busy: busy === 'accept', disabled: !!busy || !online || detailBusy || !detail?.cwd || detail?.task?.taskId !== selected, onClick: approve }, busy === 'accept' ? '正在启动…' : '接受并启动'),
          ])
        } else if (mine && record?.phase === 'unsubmitted' && task.status === 'accepted') {
          footerAction = h(Button, { key: 'resume', tone: 'primary full', icon: 'arrow', busy: busy === 'resume', disabled: !!busy || !online || !detail?.cwd || detailBusy || detail?.task?.taskId !== selected, onClick: async () => { const result = await run({ action: 'resume', taskId: task.taskId, cwd: detail.cwd }); if (result.ok) await finishStart(result) } }, '继续启动')
        } else if (mine && record?.phase === 'needs-review') {
          footerAction = h(Button, { key: 'handled', tone: 'full', disabled: !!busy || !online, onClick: () => confirm('handled', task) }, '我已核对并自行处理')
        } else {
          footerAction = h('div', { key: 'terminal', className: 'bt-hint', style: { textAlign: 'center' } }, !mine ? '审批状态会自动更新；对方的会话内容仅对本人可见。' : record?.phase === 'submitted' ? '消息已提交，可在 DSH 侧边栏中查看会话。' : record?.phase === 'handled' ? '已标记为自行处理，不会再次启动。' : task.status === 'declined' ? '你已拒绝这次接力。' : '任务已接手。')
        }
        return [
          h('div', { key: 'body', className: 'bt-detail-inner' }, [
            h('div', { key: 'kicker', className: 'bt-detail-kicker' }, [h('span', { key: 'r' }, task.room + ' / 接力详情'), h('div', { key: 'a', style: { display: 'flex', gap: 5 } }, [h('button', { key: 'back', type: 'button', className: 'bt-icon-button bt-mobile-back', 'aria-label': '返回任务列表', onClick: () => setSelected(null) }, h(Icon, { name: 'back' })), h(CopyButton, { key: 'copy', label: '复制任务标识', value: task.taskId })])]),
            h('h2', { key: 'title', className: 'bt-detail-title' }, task.title),
            h('div', { key: 'person', className: 'bt-detail-person' }, [h(Avatar, { key: 'a', name: person.displayName }), h('div', { key: 'n', style: { flex: 1 } }, [h('strong', { key: 's' }, person.displayName + (mine ? ' 发来的接力' : ' 将收到这次接力')), h('small', { key: 'd' }, relative(task.createdAt) + ' · ' + task.env)]), h(Badge, { key: 'b', value: statusFor(task, record, mine) })]),
            h('div', { key: 'label', className: 'bt-section-label' }, '任务说明'),
            detailBusy ? h('div', { key: 'loading', className: 'bt-hint', role: 'status' }, '正在读取任务说明…') : detail?.task?.taskId === selected ? h('div', { key: 'brief', className: 'bt-brief' }, detail.brief) : h('p', { key: 'missing', className: 'bt-hint' }, online ? '暂时无法读取说明，请重新选择这条任务。' : '连接恢复后即可查看任务说明。'),
            mine && detail?.task?.taskId === selected ? h('div', { key: 'directory', className: 'bt-directory' }, [h('div', { key: 'h', className: 'bt-directory-head' }, [h(Icon, { key: 'i', name: 'folder' }), '本机执行目录']), detail.cwd ? h('code', { key: 'path', className: 'bt-path' }, detail.cwd) : h('span', { key: 'err', className: 'bt-hint' }, detail.cwdError ?? '该环境尚未配置，请先完善插件配置。')]) : null,
            record?.phase === 'needs-review' ? h('div', { key: 'warning', className: 'bt-warning' }, [h('strong', { key: 't' }, '上次启动结果需要核对'), h('span', { key: 'd' }, record.sessionId ? '请先在 DSH 中检查该会话是否已有消息。确认前不会再次提交。' : '本机缺少完整启动记录，请在 DSH 会话列表中核对并自行处理。')]) : null,
            record?.phase === 'unsubmitted' && task.status === 'accepted' ? h('div', { key: 'retry', className: 'bt-warning' }, [h('strong', { key: 't' }, '已接手，尚未提交消息'), h('span', { key: 'd' }, record.sessionId ? '会话已保留。继续启动会复用同一会话与执行目录。' : '上次启动未完成，确认目录后可以继续。')]) : null,
            record?.sessionId ? h('div', { key: 'session', style: { marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
              missingSessions[record.sessionId]
                ? h('span', { key: 'missing', className: 'bt-task-link deleted' }, '会话已删除')
                : h(Button, { key: 'locate', icon: 'arrow', tone: 'ghost', disabled: !online, onClick: () => locateSession(record.sessionId) }, '定位会话'),
              h(CopyButton, { key: 'copy-session', icon: 'copy', tone: 'ghost', value: record.sessionId, label: '复制会话标识' }, '复制会话标识'),
            ]) : null,
          ]),
          h('footer', { key: 'footer', className: 'bt-detail-footer' }, [
            footerAction,
            canAccept ? h('p', { key: 'hint', className: 'bt-hint' }, '接受后才创建会话，并提交上面的任务说明。') : null,
          ]),
        ]
      }

      const renderModal = () => {
        if (!modal) return null
        const cancel = h(Button, { key: 'cancel', disabled: !!busy, onClick: modalClose }, '取消')
        if (modal.kind === 'send') {
          const selectedRoom = rooms.find(item => item.code === draft.room)
          const members = selectedRoom?.members.filter(member => member.userId !== data?.userId) ?? []
          const originalSaved = [...(data?.outbox ?? []), ...allTasks].some(item => item.taskId === draft.taskId)
          return h(Dialog, { title: '发起一次接力', description: '把任务说明交给一位队友，由对方确认后开始。', close: modalClose, footer: [cancel, h(Button, { key: 'send', tone: 'primary', icon: 'send', busy: busy === 'send', disabled: !!busy || !online || !draft.room || !draft.to || !/^[A-Za-z0-9_-]{1,64}$/.test(draft.env) || !draft.title.trim() || !draft.brief.trim() || new TextEncoder().encode(draft.brief).length > 8192, onClick: submitDraft }, uncertain ? '确认并重试投递' : '发送接力')] }, [
            draftError ? h('div', { key: 'error', className: 'bt-form-error', role: 'alert' }, draftError) : null,
            uncertain ? h('div', { key: 'separate', className: 'bt-warning' }, [
              h('span', { key: 'hint' }, originalSaved ? '原投递可能已送达。可保留记录并另建独立任务，请避免重复交办同一工作。' : '原投递记录尚未确认，请先重试或刷新，确认保存后即可另建任务。'),
              h(Button, { key: 'new', disabled: !!busy || !originalSaved, onClick: separateDraft }, '保留原投递，另建接力'),
            ]) : null,
            h('div', { key: 'people', className: 'bt-two-fields' }, [
              h(Field, { key: 'room', label: '协作房间' }, h('select', { value: draft.room, disabled: uncertain || !!busy, onChange: event => updateDraft('room', event.target.value) }, [h('option', { key: 'empty', value: '' }, '选择房间'), ...rooms.map(item => h('option', { key: item.code, value: item.code }, item.name))])),
              h(Field, { key: 'to', label: '交给谁' }, h('select', { value: draft.to, disabled: uncertain || !!busy, onChange: event => updateDraft('to', event.target.value) }, [h('option', { key: 'empty', value: '' }, '选择成员'), ...members.map(member => h('option', { key: member.userId, value: member.userId }, member.displayName + ' · ' + member.userId.slice(0, 8) + (member.online ? '' : ' · 离线')))])),
            ]),
            h(Field, { key: 'title', label: '任务标题' }, h('input', { value: draft.title, maxLength: 120, disabled: uncertain || !!busy, placeholder: '例如：完成登录页的接口联调', onChange: event => updateDraft('title', event.target.value) })),
            h(Field, { key: 'env', label: '对方的执行环境', hint: '选择本机已配置的 key，或直接填写对方使用的 key；无需知道对方路径。' }, h(EnvPicker, { value: draft.env, options: data?.environments ?? [], disabled: uncertain || !!busy, onChange: value => updateDraft('env', value) })),
            h(Field, { key: 'brief', label: '任务说明', hint: '说明目标、完成标准和必要背景。' + new TextEncoder().encode(draft.brief).length + ' / 8192 字节' }, h('textarea', { value: draft.brief, disabled: uncertain || !!busy, placeholder: '请描述任务目标与完成标准…', onChange: event => updateDraft('brief', event.target.value) })),
          ])
        }
        if (modal.kind === 'create' || modal.kind === 'join') {
          const creating = modal.kind === 'create'
          return h(Dialog, { title: creating ? '创建协作房间' : '加入协作房间', description: creating ? '创建后，把房间号分享给队友。每个房间最多 10 人。' : '向队友获取六位房间号，即可加入协作。', close: modalClose, footer: [cancel, h(Button, { key: 'ok', tone: 'primary', busy: !!busy, disabled: !!busy || !online || !roomInput.trim(), onClick: async () => { const result = await run(creating ? { action: 'create', name: roomInput.trim() } : { action: 'join', code: roomInput.trim().toUpperCase() }); if (result.ok) { setRoomCode(result.code ?? ''); setModal(null); setRoomInput(''); setNotice({ tone: 'success', message: creating ? '房间已创建，邀请队友开始协作吧。' : '已加入房间。' }) } } }, creating ? '创建房间' : '加入房间')] }, h(Field, { label: creating ? '房间名称' : '房间号' }, h('input', { autoFocus: true, value: roomInput, maxLength: creating ? 40 : 8, placeholder: creating ? '例如：产品与研发' : 'ABC234', onChange: event => setRoomInput(creating ? event.target.value : event.target.value.toUpperCase()) })))
        }
        if (modal.kind === 'rooms') {
          return h(Dialog, { title: '协作房间', description: '选择房间筛选任务，或创建、加入新的房间。', close: modalClose, footer: [h(Button, { key: 'create', disabled: !online, icon: 'plus', onClick: () => setModal({ kind: 'create' }) }, '创建房间'), h(Button, { key: 'join', disabled: !online, onClick: () => setModal({ kind: 'join' }) }, '加入房间')] }, [
            h(Button, { key: 'all', onClick: () => { setRoomCode(''); setSelected(null); setModal(null) } }, '全部接力'),
            ...rooms.map(item => h('div', { key: item.code, style: { display: 'flex', gap: 8 } }, [h(Button, { key: 'room', tone: 'full', onClick: () => { setRoomCode(item.code); setSelected(null); setModal(null) } }, item.name + ' · ' + item.code), h(IconButton, { key: 'manage', label: '管理房间 ' + item.name, icon: 'dots', onClick: () => setModal({ kind: 'room', code: item.code }) })])),
          ])
        }
        if (modal.kind === 'room') {
          const item = rooms.find(entry => entry.code === modal.code)
          if (!item) return h(Dialog, { title: '房间已移除', description: '这个房间已被其他成员解散或移除。已收到的任务仍可继续处理。', close: modalClose, footer: [h(Button, { key: 'close', onClick: modalClose }, '完成')] })
          return h(Dialog, { title: item.name, description: item.members.length + ' / 10 位成员 · 房间号仅用于加入', close: modalClose, footer: [h(Button, { key: 'exit', tone: 'danger', disabled: !!busy || !online, onClick: () => setModal({ kind: item.ownerId === data.userId ? 'disband' : 'leave', room: item }) }, item.ownerId === data.userId ? '解散房间' : '离开房间'), h(Button, { key: 'done', onClick: modalClose }, '完成')] }, [
            h('div', { key: 'code', className: 'bt-room-code' }, [h('code', { key: 'c' }, item.code), h(CopyButton, { key: 'copy', label: '复制房间号', value: item.code })]),
            h('div', { key: 'members' }, item.members.map(member => h('div', { key: member.userId, className: 'bt-room-member' }, [h(Avatar, { key: 'a', name: member.displayName }), h('div', { key: 'n' }, [h('div', { key: 'name' }, member.displayName + (member.userId === item.ownerId ? ' · 房主' : '')), h('div', { key: 'id', className: 'bt-profile-id' }, member.userId.slice(0, 8) + ' · ' + (member.online ? '在线' : '离线'))]), h(CopyButton, { key: 'copy', label: '复制 ' + member.displayName + ' 的 userId', value: member.userId })]))),
          ])
        }
        const texts = {
          decline: ['拒绝这次接力？', '对方会看到你已拒绝。不会创建或启动会话。', '确认拒绝'],
          handled: ['确认已核对并自行处理？', '这只会收起本机警告，不会提交消息，也不会再次启动任务。', '确认已处理'],
          disband: ['解散这个房间？', '所有成员将离开房间。已经投递的任务仍可继续处理。', '确认解散'],
          leave: ['离开这个房间？', '离开后无法发送新任务，已经收到的任务仍可处理。', '确认离开'],
        }
        const [title, description, label] = texts[modal.kind]
        return h(Dialog, { title, description, close: modalClose, footer: [cancel, h(Button, { key: 'ok', tone: modal.kind === 'handled' ? 'primary' : 'danger', busy: !!busy, disabled: !!busy || !online, onClick: async () => { const result = await run(modal.task ? { action: modal.kind, taskId: modal.task.taskId, confirmed: true } : { action: modal.kind, code: modal.room.code }); if (result.ok) { setModal(null); if (modal.room?.code === roomCode) setRoomCode(''); setNotice({ tone: 'success', message: modal.kind === 'handled' ? '已标记为自行处理。' : modal.kind === 'decline' ? '已拒绝这次接力。' : '房间已更新。' }) } } }, label)] }, h('p', { style: { margin: 0, color: 'var(--bt-muted)', fontSize: 12, lineHeight: 1.8 } }, modal.task?.title ?? modal.room?.name))
      }

      const shell = h('section', { ref, onKeyDown, className: 'bt-shell' + (embedded ? ' bt-embedded' : ''), role: embedded ? undefined : 'dialog', 'aria-modal': embedded ? undefined : true, 'aria-label': 'Baton 接力', style: { position: 'relative' } }, [
        h('header', { key: 'top', className: 'bt-topbar' }, [h('div', { key: 'brand', className: 'bt-brand' }, [h('span', { key: 'mark', className: 'bt-mark', 'aria-hidden': true }), h('span', { key: 'name', className: 'bt-wordmark' }, ['Baton', h('small', { key: 'cn' }, '接力')])]), h('div', { key: 'actions', className: 'bt-top-actions' }, [h('button', { key: 'rooms', className: 'bt-icon-button bt-mobile-back', type: 'button', 'aria-label': '协作房间', onClick: () => setModal({ kind: 'rooms' }) }, h(Icon, { name: 'people' })), h('span', { key: 'status', className: 'bt-connection', role: 'status' }, [h('span', { key: 'dot', className: 'bt-dot' + (online ? ' online' : '') }), connectionText]), h('span', { key: 'line', className: 'bt-divider' }), h(IconButton, { key: 'refresh', label: '刷新接力', icon: 'refresh', onClick: refresh }), embedded ? null : h(IconButton, { key: 'close', label: '关闭接力', icon: 'close', onClick: () => setOpen(false) })])]),
        h('div', { key: 'body', className: 'bt-body' }, [
          h('aside', { key: 'sidebar', className: 'bt-sidebar', 'aria-label': '协作房间' }, [
            h('div', { key: 'caption', className: 'bt-nav-caption' }, 'WORKSPACE'),
            h('button', { key: 'all', type: 'button', className: 'bt-nav' + (!roomCode ? ' active' : ''), onClick: () => { setRoomCode(''); setSelected(null) } }, [h(Icon, { key: 'i', name: 'inbox' }), '全部接力', unread ? h('span', { key: 'count', className: 'bt-count' }, unread) : null]),
            h('div', { key: 'heading', className: 'bt-sidebar-heading' }, [h('span', { key: 't' }, '协作房间'), h('span', { key: 'n' }, String(rooms.length))]),
            h('div', { key: 'rooms', className: 'bt-room-list' }, rooms.length ? rooms.map(item => h('div', { key: item.code, className: 'bt-room-row' + (roomCode === item.code ? ' active' : '') }, [h('button', { key: 'select', type: 'button', className: 'bt-room', onClick: () => { setRoomCode(item.code); setSelected(null) } }, [h('span', { key: 'symbol', className: 'bt-room-symbol' }, '#'), h('div', { key: 'text', style: { minWidth: 0 } }, [h('div', { key: 'name', className: 'bt-room-name' }, item.name), h('div', { key: 'meta', className: 'bt-room-meta' }, item.members.filter(member => member.online).length + ' 人在线 · ' + item.code)])]), h(IconButton, { key: 'more', label: '管理房间 ' + item.name, icon: 'dots', onClick: () => setModal({ kind: 'room', code: item.code }) })])) : h('p', { className: 'bt-hint', style: { padding: '0 12px' } }, '创建或加入房间，开始第一次接力。')),
            h('div', { key: 'actions', className: 'bt-room-actions' }, [h(Button, { key: 'create', icon: 'plus', disabled: !online, onClick: () => { setRoomInput(''); setModal({ kind: 'create' }) } }, '创建'), h(Button, { key: 'join', disabled: !online, onClick: () => { setRoomInput(''); setModal({ kind: 'join' }) } }, '加入')]),
            h('div', { key: 'profile', className: 'bt-profile' }, [h(Avatar, { key: 'a', name: data?.displayName }), h('div', { key: 'n', style: { minWidth: 0, flex: 1 } }, [h('div', { key: 'name', className: 'bt-profile-name' }, data?.displayName ?? '正在加载'), h('div', { key: 'id', className: 'bt-profile-id' }, data?.userId?.slice(0, 8) ?? '—')]), h(CopyButton, { key: 'copy', label: '复制我的 userId', value: String(data?.userId ?? ''), disabled: !data?.userId })]),
          ]),
          h('main', { key: 'main', className: 'bt-workspace' }, [
            h('div', { key: 'head', className: 'bt-page-head' }, [h('div', { key: 'title', className: 'bt-page-title-row' }, [h('h1', { key: 'h', className: 'bt-page-title' }, room?.name ?? '团队收件箱'), h(Button, { key: 'send', tone: 'primary', icon: 'plus', disabled: !online || !rooms.length, onClick: () => { if (!draft.room && roomCode) setDraft(previous => ({ ...previous, room: roomCode })); setModal({ kind: 'send' }) } }, '发起接力')]), h('p', { key: 'subtitle', className: 'bt-page-subtitle' }, '收到的任务，始终由你确认后启动。'), h('nav', { key: 'tabs', className: 'bt-tabs', 'aria-label': '任务方向' }, [h('button', { key: 'in', type: 'button', className: 'bt-tab' + (tab === 'incoming' ? ' active' : ''), onClick: () => switchTab('incoming') }, ['收件箱', h('span', { key: 'count', className: 'bt-count' }, incoming.length)]), h('button', { key: 'out', type: 'button', className: 'bt-tab' + (tab === 'outgoing' ? ' active' : ''), onClick: () => switchTab('outgoing') }, ['已发出的', h('span', { key: 'count', className: 'bt-count' }, outgoing.length + (data?.outbox?.length ?? 0))])])]),
            notice ? h('div', { key: 'notice', className: 'bt-message ' + notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, [h(Icon, { key: 'i', name: notice.tone === 'success' ? 'check' : 'warning' }), h('span', { key: 't' }, notice.message), h(IconButton, { key: 'x', label: '关闭提示', icon: 'close', onClick: () => setNotice(null) })]) : null,
            !online && data ? h('div', { key: 'offline', className: 'bt-message' }, [h(Icon, { key: 'i', name: 'warning' }), h('span', { key: 't' }, '暂时无法连接接力服务。已显示的任务会保留，恢复连接后即可操作。')]) : null,
            h('div', { key: 'inbox', className: 'bt-inbox' + (selected ? ' has-selection' : '') }, [
              h('section', { key: 'list', className: 'bt-task-column', 'aria-label': tab === 'incoming' ? '收到的任务' : '发出的任务' }, [
                h('div', { key: 'tools', className: 'bt-list-tools' }, [h('label', { key: 'search', className: 'bt-search' }, [h(Icon, { key: 'i', name: 'search' }), h('input', { key: 'input', value: query, placeholder: '搜索任务或成员', 'aria-label': '搜索任务或成员', onChange: event => setQuery(event.target.value) })]), h('button', { key: 'filter', type: 'button', className: 'bt-filter', 'aria-pressed': onlyAttention, onClick: () => setOnlyAttention(value => !value) }, onlyAttention ? '只看待处理' : '全部状态')]),
                h('div', { key: 'items', className: 'bt-task-list' }, [
                  ...(tab === 'outgoing' ? data?.outbox ?? [] : []).filter(item => !roomCode || item.room === roomCode).map(item => h('div', { key: item.taskId, className: 'bt-pending-send' }, [h('strong', { key: 't' }, item.title), h('span', { key: 'd' }, '投递结果待确认，原任务内容已保留。'), h(Button, { key: 'retry', disabled: !!busy || !online, busy: busy === 'retry-send', onClick: () => retrySendTask(item) }, '确认投递')])),
                  ...rows.map(renderTask),
                  !rows.length && !(tab === 'outgoing' && data?.outbox?.length) ? h(Empty, { key: 'empty', title: query ? '没有找到匹配的任务' : tab === 'incoming' ? '收件箱已清空' : '还没有发出的接力', description: query ? '试试其他标题或成员名称。' : tab === 'incoming' ? '队友发来的接力会出现在这里。' : '点击“发起接力”，把任务交给队友。', icon: tab === 'incoming' ? 'inbox' : 'send' }) : null,
                ]),
              ]),
              h('section', { key: 'detail', className: 'bt-detail', 'aria-label': '任务详情' }, renderDetail()),
            ]),
          ]),
        ]),
        h(React.Fragment, { key: 'modal' }, renderModal()),
      ])
      if (embedded) return h('div', { className: 'bt-panel-page' }, shell)
      return h('div', { className: 'bt-backdrop', onMouseDown: event => { if (event.target === event.currentTarget && !modal) setOpen(false) } }, shell)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'baton: panel styles')
        openSession = sessionId => {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (!uiWorkspace?.openSession) throw new Error('会话导航服务尚未就绪。')
          return uiWorkspace.openSession(sessionId)
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'baton', order: 15, label: '接力' }, SidebarBatonIcon))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'baton' }, MainPanel))
      },
    }
  },
})
