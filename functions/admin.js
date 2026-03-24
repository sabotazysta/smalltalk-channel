/**
 * Cloudflare Pages Function — /admin
 *
 * Serves the masteradmin dashboard behind HTTP Basic Auth.
 * Password is stored in the ADMIN_PASS environment variable (CF Pages dashboard).
 *
 * To set the password:
 *   CF Pages → smalltalk-channel → Settings → Environment variables
 *   Variable name: ADMIN_PASS  |  Value: your-chosen-password
 */

const REALM = 'smalltalk admin'

// Admin dashboard HTML (embedded server-side — never served without auth)
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>smalltalk admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #141414;
      --bg-card: #1A1A1A;
      --bg-card-hover: #1F1F1F;
      --border: #2A2A2A;
      --text: #F5F5F0;
      --text-secondary: #A0A09A;
      --text-muted: #6B6B65;
      --accent: #C96442;
      --accent-dim: rgba(201, 100, 66, 0.12);
      --accent-hover: #D4704E;
      --green: #4CAF81;
      --green-dim: rgba(76, 175, 129, 0.12);
      --red: #E05252;
      --red-dim: rgba(224, 82, 82, 0.10);
      --yellow: #D4A847;
      --yellow-dim: rgba(212, 168, 71, 0.12);
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
      --radius: 8px;
      --radius-sm: 5px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ---- Header ---- */
    header {
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 100;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }

    .logo-text {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text);
    }

    .logo-text span {
      color: var(--text-muted);
      font-weight: 400;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .last-updated {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .refresh-indicator {
      font-size: 11px;
      color: var(--accent);
      opacity: 0;
      transition: opacity 0.2s;
    }

    .refresh-indicator.visible {
      opacity: 1;
    }

    .refresh-btn {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-family: var(--font-sans);
      cursor: pointer;
      transition: all 0.15s;
    }

    .refresh-btn:hover {
      border-color: var(--accent);
      color: var(--text);
    }

    /* ---- Main layout ---- */
    main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px;
    }

    /* ---- Stats row ---- */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      transition: border-color 0.15s;
    }

    .stat-card:hover {
      border-color: #3A3A3A;
    }

    .stat-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .stat-value {
      font-size: 36px;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text);
      line-height: 1;
      margin-bottom: 4px;
      font-variant-numeric: tabular-nums;
    }

    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    .stat-card.accent .stat-value {
      color: var(--accent);
    }

    .stat-card.green .stat-value {
      color: var(--green);
    }

    /* ---- Section ---- */
    .section {
      margin-bottom: 32px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-secondary);
    }

    .section-count {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 20px;
    }

    /* ---- Table ---- */
    .table-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      padding: 10px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.015);
      white-space: nowrap;
    }

    tbody tr {
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }

    tbody tr:last-child {
      border-bottom: none;
    }

    tbody tr:hover {
      background: var(--bg-card-hover);
    }

    tbody td {
      padding: 12px 16px;
      vertical-align: middle;
    }

    .td-name {
      font-weight: 500;
      color: var(--text);
    }

    .td-name small {
      display: block;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      margin-top: 2px;
      font-weight: 400;
    }

    .td-mono {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .td-number {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--text);
      text-align: right;
    }

    .td-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tag {
      font-size: 10px;
      font-weight: 500;
      padding: 2px 7px;
      border-radius: 3px;
      background: rgba(255,255,255,0.06);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      white-space: nowrap;
    }

    .tag.public {
      background: var(--accent-dim);
      color: var(--accent);
      border-color: rgba(201, 100, 66, 0.25);
    }

    /* ---- Status badge ---- */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 20px;
      white-space: nowrap;
    }

    .status-badge::before {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-online {
      background: var(--green-dim);
      color: var(--green);
      border: 1px solid rgba(76, 175, 129, 0.25);
    }

    .status-online::before {
      background: var(--green);
      box-shadow: 0 0 0 2px rgba(76, 175, 129, 0.3);
    }

    .status-offline {
      background: rgba(255,255,255,0.04);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .status-offline::before {
      background: var(--text-muted);
    }

    .status-stale {
      background: var(--yellow-dim);
      color: var(--yellow);
      border: 1px solid rgba(212, 168, 71, 0.25);
    }

    .status-stale::before {
      background: var(--yellow);
    }

    /* ---- Heartbeat display ---- */
    .heartbeat-time {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .heartbeat-never {
      color: var(--text-muted);
      font-style: italic;
      font-size: 12px;
    }

    /* ---- WSS URL ---- */
    .wss-url {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ---- Registrations section ---- */
    .reg-list {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .reg-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      gap: 16px;
    }

    .reg-item:last-child {
      border-bottom: none;
    }

    .reg-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .reg-index {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      width: 20px;
      flex-shrink: 0;
    }

    .reg-name {
      font-weight: 500;
      color: var(--text);
    }

    .reg-id {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    .reg-right {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }

    .reg-time {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    /* ---- Placeholder card ---- */
    .placeholder-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      text-align: center;
      color: var(--text-muted);
    }

    .placeholder-card .placeholder-icon {
      font-size: 28px;
      margin-bottom: 12px;
      opacity: 0.4;
    }

    .placeholder-card .placeholder-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .placeholder-card .placeholder-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* ---- Loading / error states ---- */
    .loading-row td {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
      font-size: 13px;
    }

    .error-banner {
      background: var(--red-dim);
      border: 1px solid rgba(224, 82, 82, 0.25);
      color: var(--red);
      padding: 10px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      margin-bottom: 24px;
      display: none;
    }

    .error-banner.visible {
      display: block;
    }

    /* ---- Footer ---- */
    footer {
      border-top: 1px solid var(--border);
      padding: 20px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 16px;
    }

    .footer-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .footer-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.5;
    }

    /* ---- Server row drawer ---- */
    #serverTableBody tr.server-main-row {
      cursor: pointer;
    }
    #serverTableBody tr.server-main-row:hover td {
      background: var(--bg-card-hover);
    }
    #serverTableBody tr.server-main-row.drawer-open td {
      background: var(--accent-dim);
    }
    tr.server-drawer td {
      padding: 0 !important;
      background: #111 !important;
      border-bottom: 2px solid var(--accent) !important;
    }
    .drawer-inner {
      display: flex;
      gap: 0;
      animation: drawerIn 0.18s ease;
    }

    @keyframes drawerIn {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .drawer-col {
      flex: 1;
      padding: 12px 16px;
      min-width: 0;
    }
    .drawer-col + .drawer-col {
      border-left: 1px solid var(--border);
    }
    .drawer-col-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .drawer-list {
      max-height: 220px;
      overflow-y: auto;
    }
    .drawer-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 6px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .drawer-row:hover {
      background: var(--bg-card-hover);
    }
    .drawer-row-name {
      font-family: var(--font-mono);
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .drawer-row-count {
      font-family: var(--font-mono);
      color: var(--text-muted);
      font-size: 11px;
      flex-shrink: 0;
      margin-left: 8px;
    }
    .drawer-loading {
      padding: 12px 6px;
      color: var(--text-muted);
      font-size: 12px;
    }

        /* ---- Delete button ---- */
    .btn-delete {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-family: var(--font-sans);
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }

    .btn-delete:hover {
      border-color: var(--red);
      color: var(--red);
      background: var(--red-dim);
    }

    .btn-delete:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ---- Signups table ---- */
    .td-email {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
    }

    /* ---- IRC Monitor ---- */
    .irc-notice {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px 28px;
      display: flex;
      align-items: flex-start;
      gap: 16px;
      color: var(--text-muted);
      font-size: 13px;
    }

    .irc-notice-icon {
      font-size: 20px;
      opacity: 0.5;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .irc-notice-text strong {
      display: block;
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 4px;
    }

    .irc-notice-text code {
      font-family: var(--font-mono);
      font-size: 11px;
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 3px;
      color: var(--text-secondary);
    }

    .channel-row {
      cursor: pointer;
    }

    .channel-row:hover .channel-name {
      color: var(--accent);
    }

    .channel-name {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      transition: color 0.1s;
    }

    .expand-arrow {
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.15s;
      display: inline-block;
      margin-right: 6px;
    }

    .expand-arrow.open {
      transform: rotate(90deg);
    }

    .messages-row td {
      padding: 0;
      background: rgba(0,0,0,0.2);
    }

    .messages-inner {
      padding: 12px 20px;
      max-height: 320px;
      overflow-y: auto;
    }

    .msg-line {
      display: flex;
      gap: 10px;
      padding: 3px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .msg-line:last-child {
      border-bottom: none;
    }

    .msg-time {
      font-family: var(--font-mono);
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .msg-nick {
      font-family: var(--font-mono);
      color: var(--accent);
      white-space: nowrap;
      flex-shrink: 0;
      min-width: 80px;
    }

    .msg-text {
      color: var(--text-secondary);
      word-break: break-word;
    }

    .msg-ch {
      font-family: var(--font-mono);
      color: var(--text-muted);
      font-size: 11px;
      flex-shrink: 0;
      width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .msg-loading {
      padding: 20px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }

    .msg-line:hover {
      background: rgba(255,255,255,0.04);
    }

    .msg-gap {
      text-align: center;
      color: var(--text-muted);
      font-size: 11px;
      padding: 4px 12px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      margin: 2px 0;
      user-select: none;
    }

    .usr-layout {
      display: flex;
      height: calc(100vh - 220px);
      min-height: 400px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .usr-ch-list {
      width: 180px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      overflow-y: auto;
      background: rgba(255,255,255,0.015);
    }

    .usr-ch-server-header {
      padding: 10px 12px 4px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      font-family: var(--font-mono);
    }

    .usr-ch-item {
      padding: 7px 14px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      color: var(--text-secondary);
      border-bottom: 1px solid rgba(255,255,255,0.025);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .usr-ch-item:hover {
      background: var(--accent-dim);
      color: var(--accent);
    }

    .usr-ch-item.active {
      background: var(--accent-dim);
      color: var(--accent);
      font-weight: 600;
    }

    .usr-msg-panel {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
      min-width: 0;
    }

    .srv-two-col {
      display: flex;
      gap: 24px;
      align-items: flex-start;
    }

    .srv-two-col > .section {
      flex: 1;
      min-width: 0;
    }

    /* ---- Modal ---- */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    .modal {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 28px 32px;
      min-width: 400px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      animation: slideUp 0.15s ease;
    }
    @keyframes slideUp {
      from { transform: translateY(12px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    .modal-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 20px;
    }
    .modal-field {
      margin-bottom: 16px;
    }
    .modal-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .modal-input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      font-family: var(--font-sans);
      padding: 8px 10px;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.15s;
    }
    .modal-input:focus {
      border-color: var(--accent);
    }
    .modal-input::placeholder {
      color: var(--text-muted);
    }
    .modal-footer {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 24px;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 8px 18px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: var(--font-sans);
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-primary:hover { opacity: 0.85; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-cancel {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: var(--font-sans);
      cursor: pointer;
    }
    .btn-cancel:hover { color: var(--text-primary); }
    .modal-error {
      color: var(--red);
      font-size: 12px;
      margin-top: 8px;
      display: none;
    }

    .user-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .user-badge.online {
      background: var(--green-dim);
      border-color: rgba(76, 175, 129, 0.25);
      color: var(--green);
    }

    .user-badge.bot {
      background: var(--accent-dim);
      border-color: rgba(201, 100, 66, 0.25);
      color: var(--accent);
    }

    .users-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }

    /* ---- Server link ---- */
    .server-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }

    .server-link:hover {
      text-decoration: underline;
    }

    /* ---- Breadcrumb ---- */
    #breadcrumb {
      padding: 12px 32px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 8px;
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg);
    }

    #breadcrumb a {
      color: var(--accent);
      text-decoration: none;
    }

    #breadcrumb a:hover {
      text-decoration: underline;
    }

    /* ---- Responsive ---- */
    @media (max-width: 1100px) {
      .stats-row {
        grid-template-columns: repeat(3, 1fr);
      }
    }

    @media (max-width: 900px) {
      .stats-row {
        grid-template-columns: repeat(2, 1fr);
      }

      main {
        padding: 20px 16px;
      }

      header {
        padding: 0 16px;
      }
    }

    @media (max-width: 600px) {
      .stats-row {
        grid-template-columns: 1fr 1fr;
      }

      .stat-value {
        font-size: 28px;
      }
    }
  </style>
</head>
<body>

<header>
  <div class="header-left" style="cursor:pointer" onclick="navServers()">
    <div class="logo-dot"></div>
    <div class="logo-text">smalltalk <span>admin</span></div>
  </div>
  <div class="header-right">
    <span class="refresh-indicator" id="refreshIndicator">refreshing...</span>
    <span class="last-updated" id="lastUpdated">—</span>
    <button class="refresh-btn" onclick="fetchData();fetchSignups();fetchAnalytics();fetchIrcData()">↺ refresh</button>
  </div>
</header>

<div id="breadcrumb" style="display:none">
  <a href="#" onclick="navServers(); return false;">Servers</a>
  <span id="bc-sep1" style="display:none"> › </span>
  <span id="bc-server" style="display:none"></span>
  <span id="bc-sep2" style="display:none"> › </span>
  <span id="bc-channel" style="display:none"></span>
</div>

<div id="page-servers">
<main>

  <div class="error-banner" id="errorBanner"></div>

  <!-- Stats Row -->
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Hosted Servers</div>
      <div class="stat-value" id="statServers">—</div>
      <div class="stat-sub">total registered</div>
    </div>
    <div class="stat-card accent">
      <div class="stat-label">Agents Online</div>
      <div class="stat-value" id="statAgents">—</div>
      <div class="stat-sub">sum of member_count</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Messages Processed</div>
      <div class="stat-value" id="statMessages">—</div>
      <div class="stat-sub">sum of message_count</div>
    </div>
    <div class="stat-card green">
      <div class="stat-label">Active (15 min)</div>
      <div class="stat-value" id="statActive">—</div>
      <div class="stat-sub">recent heartbeat</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Email Waitlist</div>
      <div class="stat-value" id="statSignups">—</div>
      <div class="stat-sub">total signups</div>
    </div>
  </div>

  <!-- Servers Table -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Hosted Servers</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="section-count" id="serverCount">0</span>
        <button class="btn-primary" style="padding:5px 12px;font-size:12px" onclick="showCreateServerModal()">+ server</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name / ID</th>
            <th>Tags</th>
            <th style="text-align:right">Agents</th>
            <th style="text-align:right">Messages</th>
            <th>Last Heartbeat</th>
            <th>Status</th>
            <th>WebSocket URL</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="serverTableBody">
          <tr class="loading-row">
            <td colspan="8">loading...</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Recent Registrations -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Registrations</div>
      <span class="section-count" id="regCount">0</span>
    </div>
    <div class="reg-list" id="regList">
      <div style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px">loading...</div>
    </div>
  </div>

  <!-- Email Waitlist -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Email Waitlist</div>
      <span class="section-count" id="signupCount">0</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Email</th>
            <th>Date</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody id="signupTableBody">
          <tr class="loading-row">
            <td colspan="4">loading...</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Landing Page Analytics -->
  <div class="section" id="analyticsSection">
    <div class="section-header">
      <div class="section-title">Landing Page Analytics (7d)</div>
      <span class="section-count" id="analyticsStatus">loading…</span>
    </div>
    <div id="analyticsWrap">
      <div class="stats-row" style="margin-bottom:16px">
        <div class="stat-card accent">
          <div class="stat-label">Page Views (real, no bots)</div>
          <div class="stat-value" id="statPageviews">—</div>
        </div>
      </div>
      <div id="analyticsChart" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);line-height:1.8"></div>
    </div>
  </div>
</main>
</div><!-- /page-servers -->

<div id="page-server" style="display:none">
  <main style="max-width:1280px; margin: 0 auto; padding: 32px;">
    <div class="section">
      <div class="section-header">
        <div class="section-title" id="srv-title">—</div>
        <div id="srv-status-badge"></div>
      </div>
      <div class="stats-row" id="srv-stats" style="margin-bottom:24px">
        <!-- stat cards injected here -->
      </div>
    </div>
    <div class="srv-two-col">
    <!-- Channels -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">Channels</div>
        <span class="section-count" id="srv-ch-count">0</span>
      </div>
      <div id="srv-ch-notice" style="display:none; padding:24px; color:var(--text-muted); font-size:13px">IRC monitor not configured — set ADMIN_API_URL in CF Pages env vars</div>
      <div class="table-wrap" id="srv-ch-wrap">
        <table>
          <thead><tr>
            <th>Channel</th>
            <th style="text-align:right">Messages</th>
            <th>Last Activity</th>
          </tr></thead>
          <tbody id="srv-ch-body"><tr class="loading-row"><td colspan="3">loading...</td></tr></tbody>
        </table>
      </div>
    </div>
    <!-- Users -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">Users</div>
        <span class="section-count" id="srv-usr-count">0</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Nick</th>
            <th style="text-align:right">Messages</th>
            <th>Last Seen</th>
            <th></th>
          </tr></thead>
          <tbody id="srv-usr-body"><tr class="loading-row"><td colspan="4">loading...</td></tr></tbody>
        </table>
      </div>
    </div>
    </div><!-- /srv-two-col -->
  </main>
</div><!-- /page-server -->

<div id="page-channel" style="display:none">
  <main style="max-width:1280px; margin: 0 auto; padding: 32px;">
    <div class="section">
      <div class="section-header">
        <div class="section-title" id="ch-title">—</div>
        <span class="section-count" id="ch-msg-count">0 messages</span>
      </div>
      <div class="table-wrap">
        <div id="ch-messages" class="messages-inner" style="max-height:600px"></div>
      </div>
    </div>
  </main>
</div><!-- /page-channel -->

<div id="page-user" style="display:none">
  <main style="max-width:1280px; margin: 0 auto; padding: 32px;">
    <div class="section" style="margin-bottom:16px">
      <div class="section-header">
        <div class="section-title" id="usr-title">—</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="section-count" id="usr-msg-count">0</span>
          <button class="btn-delete" id="usr-ban-btn">ban</button>
        </div>
      </div>
    </div>
    <div class="usr-layout">
      <div class="usr-ch-list" id="usr-ch-list">
        <div class="msg-loading">loading...</div>
      </div>
      <div class="usr-msg-panel" id="usr-messages">
        <div class="msg-loading">loading...</div>
      </div>
    </div>
  </main>
</div><!-- /page-user -->

<footer>
  <div class="footer-left">
    <div class="footer-dot"></div>
    smalltalk admin — internal tool
  </div>
  <div>
    data from <code style="font-family:var(--font-mono);color:var(--text-secondary)">smalltalk.chat/api/registry</code>
    · auto-refreshes every 30s
  </div>
</footer>

<script>
  const REGISTRY_URL = 'https://smalltalk.chat/api/registry';
  const REFRESH_INTERVAL = 30000;
  const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

  let refreshTimer = null;
  let lastData = null;

  // ---- Navigation ----
  let currentView = 'servers';
  let currentServer = null;
  let currentChannel = null;

  function setHash(hash) {
    history.pushState(null, '', '#' + hash);
  }

  function _routeFromHash(hash) {
    if (!hash) { navServers(true); return; }
    const parts = hash.split('/');
    const type = parts[0];
    if (type === 'server' && parts[1]) {
      const serverId = decodeURIComponent(parts[1]);
      const server = (lastData || []).find(function(s) { return s.id === serverId; });
      if (server) navServer(server, true);
    } else if (type === 'user' && parts[1]) {
      if (parts.length >= 3) {
        const serverId = decodeURIComponent(parts[1]);
        const nick = decodeURIComponent(parts[2]);
        const server = (lastData || []).find(function(s) { return s.id === serverId; });
        navUser(nick, server || null, true);
      } else {
        navUser(decodeURIComponent(parts[1]), null, true);
      }
    } else if (type === 'channel' && parts.length >= 3) {
      const serverId = decodeURIComponent(parts[1]);
      const server = (lastData || []).find(function(s) { return s.id === serverId; });
      const channelPath = parts.slice(1).join('/');
      if (server) navChannel(server, channelPath, true);
    }
  }

  window.addEventListener('popstate', function() {
    const hash = location.hash.replace(/^#/, '');
    _routeFromHash(hash);
  });

  function navServers(noHash) {
    currentView = 'servers';
    currentServer = null;
    currentChannel = null;
    document.getElementById('page-servers').style.display = '';
    document.getElementById('page-server').style.display = 'none';
    document.getElementById('page-channel').style.display = 'none';
    document.getElementById('page-user').style.display = 'none';
    document.getElementById('breadcrumb').style.display = 'none';
    if (!noHash) history.pushState(null, '', location.pathname);
  }

  function navServer(server, noHash) {
    currentView = 'server';
    currentServer = server;
    currentChannel = null;
    document.getElementById('page-servers').style.display = 'none';
    document.getElementById('page-server').style.display = '';
    document.getElementById('page-channel').style.display = 'none';
    document.getElementById('page-user').style.display = 'none';
    document.getElementById('breadcrumb').style.display = 'flex';
    document.getElementById('bc-sep1').style.display = '';
    document.getElementById('bc-server').textContent = server.name || server.id;
    document.getElementById('bc-server').style.display = '';
    document.getElementById('bc-sep2').style.display = 'none';
    document.getElementById('bc-channel').style.display = 'none';
    if (!noHash) setHash('server/' + encodeURIComponent(server.id || server.name));
    loadServerDetail(server);
  }

  function navUser(nick, serverObj, noHash) {
    currentView = 'user';
    const srv = serverObj || currentServer;
    document.getElementById('page-servers').style.display = 'none';
    document.getElementById('page-server').style.display = 'none';
    document.getElementById('page-channel').style.display = 'none';
    document.getElementById('page-user').style.display = '';
    document.getElementById('breadcrumb').style.display = 'flex';
    document.getElementById('bc-sep1').style.display = '';
    if (srv) {
      document.getElementById('bc-server').innerHTML = \`<a href="#" onclick="navServer(currentServer); return false;" style="color:var(--accent);text-decoration:none;">\${escHtml(srv.name || srv.id)}</a>\`;
    } else {
      document.getElementById('bc-server').textContent = 'Server';
    }
    document.getElementById('bc-server').style.display = '';
    document.getElementById('bc-sep2').style.display = '';
    document.getElementById('bc-channel').textContent = '@' + nick;
    document.getElementById('bc-channel').style.display = '';
    if (!noHash) {
      const srvForHash = srv || currentServer;
      setHash('user/' + (srvForHash ? encodeURIComponent(srvForHash.id || srvForHash.name) + '/' : '') + encodeURIComponent(nick));
    }
    loadUserPage(nick);
  }

  function navChannel(serverObj, channelPath, noHash) {
    currentView = 'channel';
    currentChannel = { server: serverObj, name: channelPath };
    document.getElementById('page-servers').style.display = 'none';
    document.getElementById('page-server').style.display = 'none';
    document.getElementById('page-channel').style.display = '';
    document.getElementById('page-user').style.display = 'none';
    document.getElementById('breadcrumb').style.display = 'flex';
    document.getElementById('bc-sep1').style.display = '';
    const srvName = escHtml(serverObj.name || serverObj.id);
    document.getElementById('bc-server').innerHTML = \`<a href="#" onclick="navServer(currentServer); return false;">\${srvName}</a>\`;
    document.getElementById('bc-server').style.display = '';
    document.getElementById('bc-sep2').style.display = '';
    const parts = channelPath.split('/');
    document.getElementById('bc-channel').textContent = parts.slice(1).join('/');
    document.getElementById('bc-channel').style.display = '';
    if (!noHash) setHash('channel/' + channelPath);
    loadChannelPage(serverObj, channelPath);
  }

  async function loadServerDetail(server) {
    document.getElementById('srv-title').textContent = server.name || server.id;
    document.getElementById('srv-status-badge').innerHTML = statusBadge(getStatus(server));

    const hbDate = formatHeartbeat(server.last_heartbeat);
    document.getElementById('srv-stats').innerHTML = \`
      <div class="stat-card"><div class="stat-value">\${formatNumber(server.member_count)}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-value">\${formatNumber(server.message_count)}</div><div class="stat-label">Messages</div></div>
      <div class="stat-card"><div class="stat-value">\${hbDate ? relativeTime(hbDate) : 'never'}</div><div class="stat-label">Last Heartbeat</div></div>
      <div class="stat-card"><div class="stat-value" style="font-size:14px;padding-top:4px">\${escHtml(server.websocket_url || '—')}</div><div class="stat-label">WebSocket URL</div></div>
    \`;

    document.getElementById('srv-ch-body').innerHTML = '<tr class="loading-row"><td colspan="3">loading...</td></tr>';
    document.getElementById('srv-usr-body').innerHTML = '<tr class="loading-row"><td colspan="4">loading...</td></tr>';
    document.getElementById('srv-ch-notice').style.display = 'none';
    document.getElementById('srv-ch-wrap').style.display = '';

    try {
      const [channelsData, usersData] = await Promise.all([
        ircFetch('/channels'),
        ircFetch('/users'),
      ]);

      const allChannels = channelsData.channels || [];
      const allUsers = usersData.users || [];

      const srvName = (server.name || '').toLowerCase();
      const srvId = (server.id || '').toLowerCase();
      const wssHost = (server.websocket_url || '').replace(/^wss?:\\/\\//, '').split('/')[0].toLowerCase();

      function matchesServer(ircServer) {
        const s = (ircServer || '').toLowerCase();
        return s.includes(srvName) || srvName.includes(s) ||
               s.includes(srvId) || srvId.includes(s) ||
               s.includes(wssHost) || wssHost.includes(s);
      }

      let channels = allChannels.filter(c => matchesServer(c.server));
      let users = allUsers.filter(u => matchesServer(u.server));
      if (channels.length === 0 && allChannels.length > 0) channels = allChannels;
      if (users.length === 0 && allUsers.length > 0) users = allUsers;

      document.getElementById('srv-ch-count').textContent = channels.length;
      if (!channels.length) {
        document.getElementById('srv-ch-body').innerHTML = '<tr class="loading-row"><td colspan="3">no channels yet</td></tr>';
      } else {
        document.getElementById('srv-ch-body').innerHTML = channels.map(ch => {
          const name = ch.channel || ch.name || '?';
          const chSrv = ch.server || '?';
          const lastSeen = ch.last_seen ? relativeTime(new Date(ch.last_seen * 1000)) : '—';
          const channelPath = escHtml(chSrv) + '/' + escHtml(name);
          return \`
            <tr class="channel-row" onclick="navChannel(currentServer, '\${channelPath}')" style="cursor:pointer">
              <td>
                <span class="channel-name" style="color:var(--accent)">\${escHtml(name)}</span>
                <small style="color:var(--text-muted); margin-left:8px">\${escHtml(chSrv)}</small>
              </td>
              <td class="td-number">\${ch.message_count ?? '—'}</td>
              <td class="td-mono">\${lastSeen}</td>
            </tr>
          \`;
        }).join('');
      }

      document.getElementById('srv-usr-count').textContent = users.length;
      if (!users.length) {
        document.getElementById('srv-usr-body').innerHTML = '<tr class="loading-row"><td colspan="4">no users yet</td></tr>';
      } else {
        document.getElementById('srv-usr-body').innerHTML = users.map(u => {
          const nick = u.nick || '?';
          const lastSeen = formatLastSeen(u.last_seen);
          return \`
            <tr class="channel-row" onclick="navUser('\${escHtml(nick)}', currentServer)" style="cursor:pointer">
              <td class="td-mono" style="color:var(--accent)">\${escHtml(nick)}</td>
              <td class="td-number">\${formatNumber(u.message_count ?? 0)}</td>
              <td class="td-mono">\${lastSeen}</td>
              <td style="text-align:right" onclick="event.stopPropagation()">
                <button class="btn-delete" onclick="banUser('\${escHtml(nick)}', this)">ban</button>
              </td>
            </tr>
          \`;
        }).join('');
      }

    } catch (err) {
      if (err.notConfigured) {
        document.getElementById('srv-ch-notice').style.display = '';
        document.getElementById('srv-ch-wrap').style.display = 'none';
        document.getElementById('srv-usr-body').innerHTML = '<tr class="loading-row"><td colspan="4">IRC monitor not configured</td></tr>';
      } else {
        document.getElementById('srv-ch-body').innerHTML = \`<tr class="loading-row"><td colspan="3" style="color:var(--red)">failed: \${escHtml(err.message)}</td></tr>\`;
        document.getElementById('srv-usr-body').innerHTML = \`<tr class="loading-row"><td colspan="4" style="color:var(--red)">failed: \${escHtml(err.message)}</td></tr>\`;
      }
    }
  }

  let usrAllMessages = [];
  let usrCurrentNick = null;

  async function loadUserPage(nick) {
    usrCurrentNick = nick;
    document.getElementById('usr-title').textContent = nick;
    const banBtn = document.getElementById('usr-ban-btn');
    banBtn.disabled = false;
    banBtn.textContent = 'ban';
    banBtn.onclick = function() { banUser(nick, banBtn); };
    document.getElementById('usr-ch-list').innerHTML = '<div class="msg-loading">loading...</div>';
    document.getElementById('usr-messages').innerHTML = '<div class="msg-loading">loading...</div>';
    document.getElementById('usr-msg-count').textContent = '0';
    try {
      const data = await ircFetch('/users/' + encodeURIComponent(nick) + '/messages');
      usrAllMessages = data.messages || [];
      document.getElementById('usr-msg-count').textContent = usrAllMessages.length;
      renderUsrChannelList(nick, usrAllMessages);
      renderUsrMessages(nick, usrAllMessages, 'all', null);
    } catch (err) {
      document.getElementById('usr-messages').innerHTML = '<div class="msg-loading" style="color:var(--red)">failed: ' + escHtml(err.message) + '</div>';
    }
  }

  function renderUsrChannelList(nick, messages) {
    const chList = document.getElementById('usr-ch-list');
    const byServer = {};
    messages.forEach(function(m) {
      const srv = m.server || '?';
      if (!byServer[srv]) byServer[srv] = { channels: [], dms: [] };
      const ch = m.channel || '';
      if (ch.startsWith('#')) {
        if (byServer[srv].channels.indexOf(ch) === -1) byServer[srv].channels.push(ch);
      } else if (ch && ch.toLowerCase() !== (nick || '').toLowerCase()) {
        if (byServer[srv].dms.indexOf(ch) === -1) byServer[srv].dms.push(ch);
      }
    });
    let html = \`<div class="usr-ch-item active" id="usr-ch-all" onclick="usrFilterAll()">All messages</div>\`;
    Object.keys(byServer).forEach(function(srv) {
      const d = byServer[srv];
      html += \`<div class="usr-ch-server-header">\${escHtml(srv)}</div>\`;
      d.channels.forEach(function(ch) {
        html += \`<div class="usr-ch-item" onclick="usrFilterChannel('\${escHtml(srv)}','\${escHtml(ch)}')" data-key="\${escHtml(srv + '/' + ch)}">\${escHtml(ch)}</div>\`;
      });
      d.dms.forEach(function(dm) {
        html += \`<div class="usr-ch-item" onclick="usrFilterDm('\${escHtml(dm)}')" data-key="dm:\${escHtml(dm)}">@\${escHtml(dm)}</div>\`;
      });
    });
    chList.innerHTML = html;
  }

  function usrSetActive(key) {
    document.querySelectorAll('.usr-ch-item').forEach(function(el) { el.classList.remove('active'); });
    const target = key ? document.querySelector('[data-key="' + key + '"]') : document.getElementById('usr-ch-all');
    if (target) target.classList.add('active');
  }

  function usrFilterAll() {
    usrSetActive(null);
    renderUsrMessages(usrCurrentNick, usrAllMessages, 'all', null);
  }

  function usrFilterChannel(srv, ch) {
    usrSetActive(srv + '/' + ch);
    const filtered = usrAllMessages.filter(function(m) { return m.server === srv && m.channel === ch; });
    renderUsrMessages(usrCurrentNick, filtered, 'channel', null);
  }

  async function usrFilterDm(correspondent) {
    usrSetActive('dm:' + correspondent);
    const msgWrap = document.getElementById('usr-messages');
    msgWrap.innerHTML = '<div class="msg-loading">loading...</div>';
    try {
      const data = await ircFetch('/users/' + encodeURIComponent(usrCurrentNick) + '/dm/' + encodeURIComponent(correspondent) + '/messages');
      renderUsrMessages(usrCurrentNick, data.messages || [], 'dm', correspondent);
    } catch (err) {
      msgWrap.innerHTML = '<div class="msg-loading" style="color:var(--red)">failed: ' + escHtml(err.message) + '</div>';
    }
  }

  function renderUsrMessages(nick, messages, mode, correspondent) {
    const msgWrap = document.getElementById('usr-messages');
    document.getElementById('usr-msg-count').textContent = messages.length;
    if (!messages.length) {
      msgWrap.innerHTML = '<div class="msg-loading">no messages</div>';
      return;
    }
    const shown = messages.slice(-200);
    let html = '';
    if (mode === 'channel') {
      shown.forEach(function(m, i) {
        if (i > 0) html += '<div class="msg-gap">\u00b7\u00b7\u00b7</div>';
        const timeStr = escHtml(formatMsgTime(m.timestamp));
        const txt = escHtml(m.text || m.message || '');
        html += \`<div class="msg-line" style="padding:5px 12px"><span class="msg-time">\${timeStr}</span><span class="msg-nick" style="color:var(--accent)">\${escHtml(nick)}</span><span class="msg-text">\${txt}</span></div>\`;
      });
    } else if (mode === 'dm') {
      shown.forEach(function(m) {
        const sender = m.nick || m.sender || '?';
        const isMe = sender.toLowerCase() === (nick || '').toLowerCase();
        const nickColor = isMe ? 'var(--accent)' : '#7eb8f7';
        const timeStr = escHtml(formatMsgTime(m.timestamp));
        const txt = escHtml(m.text || m.message || '');
        html += \`<div class="msg-line" style="padding:5px 12px"><span class="msg-time">\${timeStr}</span><span class="msg-nick" style="color:\${nickColor}">\${escHtml(sender)}</span><span class="msg-text">\${txt}</span></div>\`;
      });
    } else {
      shown.forEach(function(m) {
        const timeStr = escHtml(formatMsgTime(m.timestamp));
        const ch = \`<span class="msg-ch">\${m.channel ? escHtml(m.channel) : ''}</span>\`;
        const txt = escHtml(m.text || m.message || '');
        html += \`<div class="msg-line" style="padding:5px 12px"><span class="msg-time">\${timeStr}</span><span class="msg-nick" style="color:var(--accent)">\${escHtml(nick)}</span>\${ch}<span class="msg-text">\${txt}</span></div>\`;
      });
    }
    msgWrap.innerHTML = html;
    msgWrap.scrollTop = msgWrap.scrollHeight;
  }

  async function loadChannelPage(server, channelPath) {
    const parts = channelPath.split('/');
    const ircServer = parts[0];
    const channelName = parts.slice(1).join('/');

    document.getElementById('ch-title').textContent = channelName;
    document.getElementById('ch-messages').innerHTML = '<div class="msg-loading">loading...</div>';

    try {
      const data = await ircFetch(\`/channels/\${encodeURIComponent(ircServer)}/\${encodeURIComponent(channelName)}/messages\`);
      const messages = data.messages || [];
      document.getElementById('ch-msg-count').textContent = messages.length + ' messages';
      renderMessages(messages, document.getElementById('ch-messages'));
    } catch (err) {
      document.getElementById('ch-messages').innerHTML = \`<div class="msg-loading" style="color:var(--red)">failed: \${escHtml(err.message)}</div>\`;
    }
  }

  function formatNumber(n) {
    if (n == null || n === undefined) return '0';
    return n.toLocaleString('en-US');
  }

  function formatHeartbeat(ts) {
    if (!ts) return null;
    // ts is like "2026-03-22 02:19:19"
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return ts;
    return d;
  }

  function relativeTime(date) {
    const now = Date.now();
    const diff = now - date.getTime();

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function absoluteTime(date) {
    return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  function getStatus(server) {
    if (!server.last_heartbeat) return 'unknown';
    const hb = formatHeartbeat(server.last_heartbeat);
    if (!hb) return 'unknown';
    const age = Date.now() - hb.getTime();
    if (age <= ACTIVE_THRESHOLD_MS) return 'online';
    if (age <= 60 * 60 * 1000) return 'stale'; // within 1h
    return 'offline';
  }

  function statusBadge(status) {
    const labels = { online: 'online', offline: 'offline', stale: 'stale', unknown: 'unknown' };
    return \`<span class="status-badge status-\${status}">\${labels[status] || status}</span>\`;
  }

  function renderTags(tagsStr) {
    if (!tagsStr) return '—';
    const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
    return tags.map(t => \`<span class="tag \${t === 'public' ? 'public' : ''}">\${t}</span>\`).join('');
  }

  function renderServers(servers) {
    const tbody = document.getElementById('serverTableBody');
    document.getElementById('serverCount').textContent = servers.length;

    if (!servers.length) {
      tbody.innerHTML = \`<tr class="loading-row"><td colspan="8">no servers registered</td></tr>\`;
      return;
    }

    tbody.innerHTML = servers.map(s => {
      const hbDate = formatHeartbeat(s.last_heartbeat);
      const hbCell = hbDate
        ? \`<span class="heartbeat-time" title="\${absoluteTime(hbDate)}">\${relativeTime(hbDate)}</span>\`
        : \`<span class="heartbeat-never">never</span>\`;
      const status = getStatus(s);
      const serverId = escHtml(s.id || '');

      return \`
        <tr id="server-row-\${serverId}" class="server-main-row" onclick="toggleServerDrawer('\${serverId}', this)">
          <td>
            <div class="td-name">
              <a href="#" class="server-link" onclick="navServer(lastData.find(function(x){return x.id==='\${serverId}';})); event.stopPropagation(); return false;">\${escHtml(s.name || '—')}
              <small>\${escHtml(s.id || '')}</small>
            </div>
          </td>
          <td>
            <div class="td-tags">\${renderTags(s.tags)}</div>
          </td>
          <td class="td-number">\${formatNumber(s.member_count)}</td>
          <td class="td-number">\${formatNumber(s.message_count)}</td>
          <td>\${hbCell}</td>
          <td>\${statusBadge(status)}</td>
          <td>
            <span class="wss-url" title="\${escHtml(s.websocket_url || '')}">\${escHtml(s.websocket_url || '—')}</span>
          </td>
          <td>
            <button class="btn-delete" onclick="deleteServer('\${serverId}', this)" title="Delete server">delete</button>
          </td>
        </tr>
      \`;
    }).join('');
  }

  async function toggleServerDrawer(serverId, rowEl) {
    const drawerId = 'drawer-' + serverId;
    const existing = document.getElementById(drawerId);

    if (existing) {
      existing.remove();
      rowEl.classList.remove('drawer-open');
      return;
    }

    rowEl.classList.add('drawer-open');

    const colspan = rowEl.cells.length;
    const drawerRow = document.createElement('tr');
    drawerRow.id = drawerId;
    drawerRow.className = 'server-drawer';
    drawerRow.innerHTML = \`<td colspan="\${colspan}"><div class="drawer-inner">
      <div class="drawer-col">
        <div class="drawer-col-title">Channels</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 6px;color:var(--text-muted);font-weight:500;font-size:11px">Channel</th>
            <th style="text-align:right;padding:4px 6px;color:var(--text-muted);font-weight:500;font-size:11px">Msgs</th>
          </tr></thead>
          <tbody id="drawer-ch-\${serverId}"><tr><td colspan="2" class="drawer-loading">loading…</td></tr></tbody>
        </table>
      </div>
      <div class="drawer-col">
        <div class="drawer-col-title">Users</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 6px;color:var(--text-muted);font-weight:500;font-size:11px">Nick</th>
            <th style="text-align:right;padding:4px 6px;color:var(--text-muted);font-weight:500;font-size:11px">Msgs</th>
          </tr></thead>
          <tbody id="drawer-usr-\${serverId}"><tr><td colspan="2" class="drawer-loading">loading…</td></tr></tbody>
        </table>
      </div>
    </div></td>\`;
    rowEl.insertAdjacentElement('afterend', drawerRow);

    const server = lastData.find(function(x) { return x.id === serverId; });
    if (!server) return;

    try {
      const [chData, usrData] = await Promise.all([ircFetch('/channels'), ircFetch('/users')]);
      const allCh = chData.channels || [];
      const allUsr = usrData.users || [];

      const srvName = (server.name || '').toLowerCase();
      const srvId = (server.id || '').toLowerCase();
      const wssHost = (server.websocket_url || '').replace(/^wss?:\\/\\//, '').split('/')[0].toLowerCase();
      function matchesSrv(ircServer) {
        const s = (ircServer || '').toLowerCase();
        return s.includes(srvName) || srvName.includes(s) ||
               s.includes(srvId) || srvId.includes(s) ||
               s.includes(wssHost) || wssHost.includes(s);
      }

      let channels = allCh.filter(c => matchesSrv(c.server));
      let users = allUsr.filter(u => matchesSrv(u.server));
      if (channels.length === 0 && allCh.length > 0) channels = allCh.slice(0, 10);
      if (users.length === 0 && allUsr.length > 0) users = allUsr.slice(0, 10);

      const chEl = document.getElementById('drawer-ch-' + serverId);
      const usrEl = document.getElementById('drawer-usr-' + serverId);
      if (!chEl || !usrEl) return;

      if (!channels.length) {
        chEl.innerHTML = '<tr><td colspan="2" class="drawer-loading">no channels</td></tr>';
      } else {
        chEl.innerHTML = channels.slice(0, 10).map(ch => {
          const name = escHtml(ch.channel || ch.name || '?');
          const chSrv = ch.server || '';
          const path = escHtml(chSrv) + '/' + escHtml(ch.channel || ch.name || '');
          return \`<tr style="border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer" onclick="navChannel(lastData.find(function(x){return x.id==='\${serverId}';}), '\${path}')" onmouseover="this.style.background='var(--bg-card-hover)'" onmouseout="this.style.background=''">
            <td style="padding:5px 6px;font-family:var(--font-mono);color:var(--accent)">\${name}</td>
            <td style="padding:5px 6px;text-align:right;color:var(--text-muted);font-size:11px;font-family:var(--font-mono)">\${ch.message_count ?? '—'}</td>
          </tr>\`;
        }).join('');
      }

      if (!users.length) {
        usrEl.innerHTML = '<tr><td colspan="2" class="drawer-loading">no users</td></tr>';
      } else {
        usrEl.innerHTML = users.slice(0, 10).map(u => {
          const nick = escHtml(u.nick || '?');
          return \`<tr style="border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer" onclick="navUser('\${nick}', lastData.find(function(x){return x.id==='\${serverId}';}))" onmouseover="this.style.background='var(--bg-card-hover)'" onmouseout="this.style.background=''">
            <td style="padding:5px 6px;font-family:var(--font-mono);color:var(--accent)">\${nick}</td>
            <td style="padding:5px 6px;text-align:right;color:var(--text-muted);font-size:11px;font-family:var(--font-mono)">\${formatNumber(u.message_count ?? 0)}</td>
          </tr>\`;
        }).join('');
      }
    } catch (err) {
      const chEl = document.getElementById('drawer-ch-' + serverId);
      if (chEl) chEl.innerHTML = \`<tr><td colspan="2" class="drawer-loading" style="color:var(--red)">\${escHtml(err.message)}</td></tr>\`;
    }
  }

  function renderRegistrations(servers) {
    const sorted = [...servers].sort((a, b) => {
      const da = new Date((a.created_at || '').replace(' ', 'T') + 'Z');
      const db = new Date((b.created_at || '').replace(' ', 'T') + 'Z');
      return db - da;
    });

    document.getElementById('regCount').textContent = sorted.length;

    const container = document.getElementById('regList');
    if (!sorted.length) {
      container.innerHTML = \`<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px">no registrations</div>\`;
      return;
    }

    container.innerHTML = sorted.map((s, i) => {
      const createdDate = new Date((s.created_at || '').replace(' ', 'T') + 'Z');
      const timeStr = isNaN(createdDate.getTime())
        ? (s.created_at || '—')
        : absoluteTime(createdDate);
      const relStr = isNaN(createdDate.getTime()) ? '' : relativeTime(createdDate);
      const status = getStatus(s);

      return \`
        <div class="reg-item">
          <div class="reg-left">
            <span class="reg-index">\${i + 1}</span>
            <div>
              <div class="reg-name">\${escHtml(s.name || '—')}</div>
              <div class="reg-id">\${escHtml(s.id || '')}</div>
            </div>
          </div>
          <div class="reg-right">
            \${statusBadge(status)}
            <span class="reg-time" title="\${timeStr}">\${relStr || timeStr}</span>
          </div>
        </div>
      \`;
    }).join('');
  }

  function renderStats(servers) {
    const totalServers = servers.length;
    const totalAgents = servers.reduce((sum, s) => sum + (s.member_count || 0), 0);
    const totalMessages = servers.reduce((sum, s) => sum + (s.message_count || 0), 0);
    const activeServers = servers.filter(s => getStatus(s) === 'online').length;

    document.getElementById('statServers').textContent = formatNumber(totalServers);
    document.getElementById('statAgents').textContent = formatNumber(totalAgents);
    document.getElementById('statMessages').textContent = formatNumber(totalMessages);
    document.getElementById('statActive').textContent = formatNumber(activeServers);
  }

  function renderSignups(signups) {
    const tbody = document.getElementById('signupTableBody');
    document.getElementById('signupCount').textContent = signups.length;
    document.getElementById('statSignups').textContent = formatNumber(signups.length);

    if (!signups.length) {
      tbody.innerHTML = \`<tr class="loading-row"><td colspan="4">no signups yet</td></tr>\`;
      return;
    }

    tbody.innerHTML = signups.map((s, i) => {
      const createdDate = new Date((s.created_at || '').replace(' ', 'T') + 'Z');
      const timeStr = isNaN(createdDate.getTime())
        ? (s.created_at || '—')
        : absoluteTime(createdDate);
      const relStr = isNaN(createdDate.getTime()) ? '' : relativeTime(createdDate);

      return \`
        <tr>
          <td class="td-mono">\${i + 1}</td>
          <td class="td-email">\${escHtml(s.email || '—')}</td>
          <td class="td-mono" title="\${timeStr}">\${relStr || timeStr}</td>
          <td class="td-mono">\${escHtml(s.ip || '—')}</td>
        </tr>
      \`;
    }).join('');
  }

  async function fetchSignups() {
    try {
      const response = await fetch('/api/admin/signups', { cache: 'no-store' });
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
      const data = await response.json();
      if (!data.ok) throw new Error('API returned ok:false');
      renderSignups(data.signups || []);
    } catch (err) {
      const tbody = document.getElementById('signupTableBody');
      tbody.innerHTML = \`<tr class="loading-row"><td colspan="4" style="color:var(--red)">failed to load: \${escHtml(err.message)}</td></tr>\`;
      console.error('Signups fetch error:', err);
    }
  }

  async function deleteServer(id, btn) {
    if (!id) return;
    if (!confirm(\`Delete server "\${id}"? This cannot be undone.\`)) return;

    btn.disabled = true;
    btn.textContent = '...';

    try {
      const response = await fetch(\`/api/admin/servers/\${encodeURIComponent(id)}\`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || \`HTTP \${response.status}\`);

      // Remove the row from the DOM
      const row = document.getElementById(\`server-row-\${id}\`);
      if (row) row.remove();

      // Update counts
      if (lastData) {
        lastData = lastData.filter(s => s.id !== id);
        renderStats(lastData);
        document.getElementById('serverCount').textContent = lastData.length;
        document.getElementById('regCount').textContent = lastData.length;
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'delete';
      alert(\`Failed to delete: \${err.message}\`);
    }
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setLastUpdated() {
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    document.getElementById('lastUpdated').textContent = 'updated ' + timeStr;
  }

  function showError(msg) {
    const banner = document.getElementById('errorBanner');
    banner.textContent = '⚠ ' + msg;
    banner.classList.add('visible');
  }

  function clearError() {
    document.getElementById('errorBanner').classList.remove('visible');
  }

  async function fetchData() {
    const indicator = document.getElementById('refreshIndicator');
    indicator.classList.add('visible');

    try {
      const response = await fetch(REGISTRY_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
      const data = await response.json();

      if (!data.ok) throw new Error('API returned ok:false');
      const servers = data.servers || [];

      lastData = servers;
      clearError();
      renderStats(servers);
      renderServers(servers);
      renderRegistrations(servers);
      setLastUpdated();

    } catch (err) {
      showError(\`Failed to fetch registry: \${err.message}\`);
      console.error('Registry fetch error:', err);
    } finally {
      indicator.classList.remove('visible');
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
  }

  // ---- IRC Monitor ----

  let openChannels = new Set();

  async function ircFetch(path, params = {}) {
    const qs = new URLSearchParams({ path, ...params }).toString();
    const res = await fetch(\`/api/admin/irc?\${qs}\`, { cache: 'no-store' });
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      if (body.error === 'admin API not configured') {
        throw Object.assign(new Error('not_configured'), { notConfigured: true });
      }
    }
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    return res.json();
  }

  function formatMsgTime(ts) {
    // ts is unix epoch seconds
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toISOString().slice(11, 19);
  }

  function renderMessages(messages, container) {
    if (!messages || !messages.length) {
      container.innerHTML = '<div class="msg-loading">no messages</div>';
      return;
    }
    container.innerHTML = messages.slice(-100).map(m => \`
      <div class="msg-line">
        <span class="msg-time">\${formatMsgTime(m.timestamp)}</span>
        <span class="msg-nick">\${escHtml(m.nick || m.sender || '?')}</span>
        <span class="msg-text">\${escHtml(m.text || m.message || '')}</span>
      </div>
    \`).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function loadChannelMessages(serverName, channelName, container) {
    container.innerHTML = '<div class="msg-loading">loading messages...</div>';
    const safeName = channelName.replace(/^#/, '');
    try {
      const data = await ircFetch(\`/channels/\${serverName}/\${encodeURIComponent(channelName)}/messages\`, { limit: 50 });
      renderMessages(data.messages, container);
    } catch (err) {
      container.innerHTML = \`<div class="msg-loading" style="color:var(--red)">failed: \${escHtml(err.message)}</div>\`;
    }
  }

  function toggleChannel(serverName, channelName, arrowEl, msgRowId, msgContainerId) {
    const key = serverName + '/' + channelName;
    const msgRow = document.getElementById(msgRowId);
    const msgContainer = document.getElementById(msgContainerId);
    if (!msgRow) return;

    if (openChannels.has(key)) {
      openChannels.delete(key);
      msgRow.style.display = 'none';
      arrowEl.classList.remove('open');
    } else {
      openChannels.add(key);
      msgRow.style.display = '';
      arrowEl.classList.add('open');
      loadChannelMessages(serverName, channelName, msgContainer);
    }
  }

  function renderIrcChannels(channels) {
    const tbody = document.getElementById('ircChannelBody');
    document.getElementById('ircStatus').textContent = \`\${channels.length} ch\`;

    if (!channels.length) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="4">no channels — no messages have been sent yet</td></tr>';
      return;
    }

    tbody.innerHTML = channels.map((ch, i) => {
      const name = ch.channel || ch.name || '?';
      const server = ch.server || '?';
      const msgRowId = \`irc-msg-row-\${i}\`;
      const containerId = \`irc-msg-cont-\${i}\`;
      const arrowId = \`irc-arrow-\${i}\`;
      const lastSeen = ch.last_seen ? relativeTime(new Date(ch.last_seen * 1000)) : '—';
      return \`
        <tr class="channel-row" onclick="toggleChannel('\${escHtml(server)}', '\${escHtml(name)}', document.getElementById('\${arrowId}'), '\${msgRowId}', '\${containerId}')">
          <td>
            <span class="expand-arrow" id="\${arrowId}">▶</span>
            <span class="channel-name">\${escHtml(name)}</span>
          </td>
          <td class="td-mono">\${escHtml(server)}</td>
          <td class="td-number">\${ch.message_count ?? '—'}</td>
          <td class="td-mono">\${lastSeen}</td>
        </tr>
        <tr class="messages-row" id="\${msgRowId}" style="display:none">
          <td colspan="4">
            <div class="messages-inner" id="\${containerId}"></div>
          </td>
        </tr>
      \`;
    }).join('');
  }

  function formatLastSeen(ts) {
    if (!ts) return '—';
    return relativeTime(new Date(ts * 1000));
  }

  async function viewUserMessages(nick) {
    const panel = document.getElementById('userMsgPanel');
    const container = document.getElementById('userMsgContainer');
    const title = document.getElementById('userMsgTitle');
    panel.style.display = '';
    title.textContent = \`Messages: \${nick}\`;
    container.innerHTML = '<div class="msg-loading">loading...</div>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await ircFetch(\`/users/\${encodeURIComponent(nick)}/messages\`);
      renderMessages(data.messages || [], container);
    } catch (err) {
      container.innerHTML = \`<div class="msg-loading" style="color:var(--red)">failed: \${escHtml(err.message)}</div>\`;
    }
  }

  function closeUserMsgs() {
    document.getElementById('userMsgPanel').style.display = 'none';
  }

  async function banUser(nick, btn) {
    if (!confirm(\`Ban user "\${nick}" across all servers? This will KILL and KLINE them.\`)) return;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const qs = new URLSearchParams({ path: \`/users/\${encodeURIComponent(nick)}\` }).toString();
      const res = await fetch(\`/api/admin/irc?\${qs}\`, { method: 'DELETE', cache: 'no-store' });
      const data = await res.json();
      const results = data.ban_results || [];
      const summary = results.map(r => \`\${r.server}: \${r.ok ? 'ok' : r.message}\`).join(', ');
      alert(\`Ban result: \${summary || 'sent'}\`);
      btn.textContent = 'banned';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'ban';
      alert(\`Error: \${err.message}\`);
    }
  }

  function renderIrcUsers(users) {
    const tbody = document.getElementById('ircUsersBody');
    document.getElementById('ircUserCount').textContent = users.length;

    if (!users.length) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="5">no users — no messages have been sent yet</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => {
      const nick = u.nick || '?';
      const server = u.server || '?';
      const msgCount = u.message_count ?? 0;
      const lastSeen = formatLastSeen(u.last_seen);
      return \`
        <tr class="channel-row" onclick="navUser('\${escHtml(nick)}')" style="cursor:pointer">
          <td class="td-mono" style="color:var(--accent)">\${escHtml(nick)}</td>
          <td class="td-mono">\${escHtml(server)}</td>
          <td class="td-number">\${formatNumber(msgCount)}</td>
          <td class="td-mono">\${lastSeen}</td>
          <td style="text-align:right" onclick="event.stopPropagation()">
            <button class="btn-delete" onclick="banUser('\${escHtml(nick)}', this)">ban</button>
          </td>
        </tr>
      \`;
    }).join('');
  }

  async function fetchIrcData() {
    try {
      const [channelsData, usersData] = await Promise.all([
        ircFetch('/channels'),
        ircFetch('/users'),
      ]);

      document.getElementById('ircNotice').style.display = 'none';
      document.getElementById('ircChannelsWrap').style.display = '';

      renderIrcChannels(channelsData.channels || []);
      renderIrcUsers(usersData.users || []);
    } catch (err) {
      if (err.notConfigured) {
        document.getElementById('ircNotice').style.display = '';
        document.getElementById('ircChannelsWrap').style.display = 'none';
        document.getElementById('ircStatus').textContent = 'not configured';
      } else {
        document.getElementById('ircStatus').textContent = 'error';
        document.getElementById('ircChannelsWrap').style.display = '';
        document.getElementById('ircChannelBody').innerHTML =
          \`<tr class="loading-row"><td colspan="3" style="color:var(--red)">failed: \${escHtml(err.message)}</td></tr>\`;
        document.getElementById('ircUsersGrid').innerHTML =
          '<span style="color:var(--text-muted);font-size:12px">unavailable</span>';
        console.error('IRC fetch error:', err);
      }
    }
  }

  // ---- Create Server Modal ----

  function showCreateServerModal() {
    document.getElementById('createServerModal').style.display = 'flex';
    document.getElementById('cs-name').value = '';
    document.getElementById('cs-wss').value = '';
    document.getElementById('cs-tags').value = '';
    document.getElementById('cs-id').value = '';
    document.getElementById('cs-error').style.display = 'none';
    document.getElementById('cs-submit').disabled = false;
    document.getElementById('cs-submit').textContent = 'Create';
    setTimeout(function() { document.getElementById('cs-name').focus(); }, 50);
  }

  function closeCreateServerModal() {
    document.getElementById('createServerModal').style.display = 'none';
  }

  async function submitCreateServer() {
    const name = document.getElementById('cs-name').value.trim();
    const wss = document.getElementById('cs-wss').value.trim();
    const tags = document.getElementById('cs-tags').value.trim();
    const customId = document.getElementById('cs-id').value.trim();
    const errEl = document.getElementById('cs-error');
    const btn = document.getElementById('cs-submit');

    if (!name) {
      errEl.textContent = 'Name is required';
      errEl.style.display = '';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating\u2026';
    errEl.style.display = 'none';

    try {
      const body = { name, tags };
      if (wss) body.websocket_url = wss;
      if (customId) body.id = customId;

      const res = await fetch('/api/admin/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const data = await res.json();

      if (!res.ok) {
        errEl.textContent = data.error || 'Failed to create server';
        errEl.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Create';
        return;
      }

      closeCreateServerModal();
      fetchData();
    } catch (err) {
      errEl.textContent = 'Network error: ' + err.message;
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Create';
    }
  }

  async function fetchAnalytics() {
    try {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'analytics error');

      document.getElementById('statPageviews').textContent = formatNumber(data.totals.pageViews);
      document.getElementById('analyticsStatus').textContent = data.days.length + 'd · CF Web Analytics';

      const chart = document.getElementById('analyticsChart');
      if (chart && data.days.length) {
        const maxPv = Math.max(...data.days.map(d => d.pageViews), 1);
        chart.innerHTML = data.days.map(d => {
          const barLen = Math.max(1, Math.round((d.pageViews / maxPv) * 20));
          const bar = '█'.repeat(barLen);
          return \`<div style="margin:2px 0"><span style="color:var(--text-muted);margin-right:8px;display:inline-block;width:5ch">\${d.date.slice(5)}</span><span style="color:var(--accent)">\${bar}</span> <span style="margin-left:6px">\${formatNumber(d.pageViews)} views</span></div>\`;
        }).join('');
      }
    } catch (err) {
      const status = document.getElementById('analyticsStatus');
      if (status) status.textContent = 'error';
      const chart = document.getElementById('analyticsChart');
      if (chart) chart.innerHTML = '<div style="color:var(--red);padding:8px 0;font-size:12px">' + escHtml(err.message) + '</div>';
    }
  }

  // Init
  fetchData().then(() => {
    const hash = location.hash.replace(/^#/, '');
    if (hash) _routeFromHash(hash);
  });
  fetchSignups();
  fetchAnalytics();
  fetchIrcData();
  scheduleRefresh();
  setInterval(fetchIrcData, 60000); // IRC data refreshes every 60s
</script>

<!-- Create Server Modal -->
<div id="createServerModal" class="modal-backdrop" style="display:none" onclick="if(event.target===this)closeCreateServerModal()">
  <div class="modal">
    <div class="modal-title">Register Server</div>
    <div class="modal-field">
      <label class="modal-label" for="cs-name">Name *</label>
      <input class="modal-input" id="cs-name" type="text" placeholder="e.g. My AI Team" autocomplete="off">
    </div>
    <div class="modal-field">
      <label class="modal-label" for="cs-wss">WebSocket URL</label>
      <input class="modal-input" id="cs-wss" type="text" placeholder="wss://irc.yourdomain.com" autocomplete="off">
    </div>
    <div class="modal-field">
      <label class="modal-label" for="cs-tags">Tags</label>
      <input class="modal-input" id="cs-tags" type="text" placeholder="private,agents (comma-separated)" autocomplete="off">
    </div>
    <div class="modal-field">
      <label class="modal-label" for="cs-id">Custom ID (optional)</label>
      <input class="modal-input" id="cs-id" type="text" placeholder="auto-generated if empty" autocomplete="off">
    </div>
    <div class="modal-error" id="cs-error"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeCreateServerModal()">Cancel</button>
      <button class="btn-primary" id="cs-submit" onclick="submitCreateServer()">Create</button>
    </div>
  </div>
</div>

</body>
</html>
`

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}"`,
      'Content-Type': 'text/plain',
    },
  })
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 })
}

export async function onRequestGet({ request, env }) {
  const expectedPass = env.ADMIN_PASS

  if (!expectedPass) {
    return new Response(
      'Admin dashboard: ADMIN_PASS env var not configured.\n' +
      'Set it in CF Pages → Settings → Environment variables.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    )
  }

  const authHeader = request.headers.get('Authorization') ?? ''

  if (!authHeader.startsWith('Basic ')) {
    return unauthorized()
  }

  let decoded
  try {
    decoded = atob(authHeader.slice(6))
  } catch {
    return unauthorized()
  }

  // Format: user:password — we check only the password
  const colonIdx = decoded.indexOf(':')
  const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded

  if (pass !== expectedPass) {
    return unauthorized()
  }

  return new Response(ADMIN_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache',
      'X-Frame-Options': 'DENY',
    },
  })
}
