<!doctype html>
<html lang="en">
	<head>

	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, user-scalable=no">

	<link rel="preload" as="script" href="js/loading-error-handlers.js?v=<%- cacheBust %>">
	<link rel="preload" as="script" href="js/bundle.vendor.js?v=<%- cacheBust %>">
	<link rel="preload" as="script" href="js/bundle.js?v=<%- cacheBust %>"></link>

	<link rel="stylesheet" href="css/style.css?v=<%- cacheBust %>">
	<link id="theme" rel="stylesheet" href="themes/<%- theme %>.css?v=<%- cacheBust %>" data-server-theme="<%- theme %>">
	<% _.forEach(stylesheets, function(css) { %>
		<link rel="stylesheet" href="packages/<%- css %>">
	<% }); %>
	<style id="user-specified-css"></style>

	<title>Smalltalk</title>

	<link id="favicon" rel="icon" sizes="16x16 32x32 64x64" href="favicon.ico" data-other="img/favicon-alerted.ico" type="image/x-icon">
	<link rel="mask-icon" href="img/icon-black-transparent-bg.svg" color="#c96442">
	<link rel="manifest" href="thelounge.webmanifest">
	<link rel="apple-touch-icon" sizes="120x120" href="img/logo-grey-bg-120x120px.png">
	<link rel="apple-touch-icon" sizes="152x152" href="img/logo-grey-bg-152x152px.png">
	<link rel="apple-touch-icon" sizes="167x167" href="img/logo-grey-bg-167x167px.png">
	<link rel="apple-touch-icon" sizes="180x180" href="img/logo-grey-bg-180x180px.png">

	<meta name="application-name" content="Smalltalk">
	<meta name="msapplication-TileColor" content="<%- themeColor %>">
	<meta name="msapplication-square70x70logo" content="img/logo-grey-bg-120x120px.png">
	<meta name="msapplication-square150x150logo" content="img/logo-grey-bg-152x152px.png">

	<meta name="apple-mobile-web-app-capable" content="yes">
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
	<meta name="apple-mobile-web-app-title" content="Smalltalk">
	<meta name="mobile-web-app-capable" content="yes">
	<meta name="theme-color" content="<%- themeColor %>">

	<style>
		/* Dark/light toggle button */
		#st-theme-toggle {
			position: fixed;
			bottom: 16px;
			right: 16px;
			z-index: 9999;
			background: #c96442;
			color: #fff;
			border: none;
			border-radius: 20px;
			padding: 6px 14px;
			font-size: 12px;
			font-family: ui-monospace, "JetBrains Mono", monospace;
			cursor: pointer;
			opacity: 0.85;
			transition: opacity 0.2s, background 0.2s;
			box-shadow: 0 2px 8px rgba(0,0,0,0.4);
		}
		#st-theme-toggle:hover {
			opacity: 1;
			background: #d97f5a;
		}
	</style>

	</head>
	<body class="<%- public ? " public" : "" %>" data-transports="<%- JSON.stringify(transports) %>">
		<div id="app"></div>
		<div id="loading">
			<div class="window">
				<div id="loading-status-container">
					<img src="img/logo-vertical-transparent-bg.svg" class="logo" alt="" width="256" height="170" style="display:none">
					<img src="img/logo-vertical-transparent-bg-inverted.svg" class="logo-inverted" alt="" width="256" height="170" style="display:none">
				<img src="img/smalltalk-logo.png?v=<%- cacheBust %>" id="st-logo" alt="smalltalk" width="256" height="170" style="display:none">
					<p id="loading-page-message">Smalltalk requires a modern browser with JavaScript enabled.</p>
				</div>
				<div id="loading-reload-container">
					<p id="loading-slow">This is taking longer than it should, there might be connectivity issues.</p>
					<button id="loading-reload" class="btn">Reload page</button>
				</div>
			</div>
		</div>
		<script src="js/loading-error-handlers.js?v=<%- cacheBust %>"></script>
		<script src="js/bundle.vendor.js?v=<%- cacheBust %>"></script>
		<script src="js/bundle.js?v=<%- cacheBust %>"></script>

		<!-- Smalltalk dark/light mode toggle -->
		<script>
		(function() {
			var DARK_THEME = 'smalltalk';
			var LIGHT_THEME = 'default';
			var STORAGE_KEY = 'st_theme_mode';

			function getThemeLink() {
				return document.getElementById('theme');
			}

			function getCurrentMode() {
				return localStorage.getItem(STORAGE_KEY) || 'dark';
			}

			function applyTheme(mode) {
				var link = getThemeLink();
				if (!link) return;
				link.href = 'themes/' + (mode === 'dark' ? DARK_THEME : LIGHT_THEME) + '.css';
				var btn = document.getElementById('st-theme-toggle');
				if (btn) btn.textContent = mode === 'dark' ? '☀ light' : '☾ dark';
				localStorage.setItem(STORAGE_KEY, mode);
			}

			function createToggle() {
				if (document.getElementById('st-theme-toggle')) return;
				var btn = document.createElement('button');
				btn.id = 'st-theme-toggle';
				var mode = getCurrentMode();
				btn.textContent = mode === 'dark' ? '☀ light' : '☾ dark';
				btn.onclick = function() {
					var current = getCurrentMode();
					applyTheme(current === 'dark' ? 'light' : 'dark');
				};
				document.body.appendChild(btn);
			}

			// Apply saved theme on load
			var savedMode = getCurrentMode();
			if (savedMode !== 'dark') {
				// Wait for DOM to be ready to swap theme
				window.addEventListener('DOMContentLoaded', function() {
					applyTheme(savedMode);
				});
			}

			// Create toggle button after page loads
			window.addEventListener('load', function() {
				createToggle();
			});
			// Fallback if already loaded
			if (document.readyState === 'complete') {
				createToggle();
			}
		})();
		</script>
	</body>
</html>
