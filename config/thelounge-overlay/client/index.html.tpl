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
		/* Toggle button — hidden until moved into #footer by JS */
		#st-theme-toggle {
			display: none;
			border-radius: 5px;
			cursor: pointer;
			height: 100%;
			width: 45px;
			font-size: 16px;
			background: transparent;
			border: none;
			opacity: 0.7;
			transition: opacity 0.15s, color 0.15s, background 0.15s;
		}
		#st-theme-toggle:hover {
			opacity: 1;
			background-color: rgba(48, 62, 74, 0.5);
		}
		/* Show once moved into footer */
		#footer #st-theme-toggle {
			display: inline-block;
		}

		/* Smalltalk logo in sidebar — CSS wordmark, works in both themes */
		#sidebar .logo-container img {
			display: none !important;
		}
		#sidebar .logo-container::before {
			content: "smalltalk";
			display: block;
			color: #c96442;
			font-size: 15px;
			font-weight: 700;
			letter-spacing: -0.5px;
			font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", monospace;
			text-align: center;
			padding: 13px 8px;
		}
	</style>

	</head>
	<body class="<%- public ? " public" : "" %>" data-transports="<%- JSON.stringify(transports) %>">
		<button id="st-theme-toggle" title="Toggle dark/light mode">☾</button>
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
			var btn = document.getElementById('st-theme-toggle');

			function getCurrentMode() {
				return localStorage.getItem(STORAGE_KEY) || 'dark';
			}

			function applyTheme(mode) {
				var link = document.getElementById('theme');
				if (link) link.href = 'themes/' + (mode === 'dark' ? DARK_THEME : LIGHT_THEME) + '.css';
				if (btn) btn.textContent = mode === 'dark' ? '☀' : '☾';
				if (btn) btn.title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
				localStorage.setItem(STORAGE_KEY, mode);
			}

			if (btn) {
				btn.onclick = function() {
					applyTheme(getCurrentMode() === 'dark' ? 'light' : 'dark');
				};
			}

			// Apply saved theme immediately
			applyTheme(getCurrentMode());

			// Move button into #footer (next to ? button) once Vue renders it
			var observer = new MutationObserver(function() {
				var footer = document.getElementById('footer');
				if (footer && btn && btn.parentNode !== footer) {
					footer.appendChild(btn);
					observer.disconnect();
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
		})();
		</script>
		<!-- Smalltalk: inject logo into sign-in form -->
		<script>
		(function() {
			var LOGO_SRC = 'img/smalltalk-logo.png?v=<%- cacheBust %>';

			function injectSignInLogo() {
				var signIn = document.getElementById('sign-in');
				if (!signIn) return false;
				if (signIn.querySelector('.st-logo-injected')) return true; // already done

				// Find the logo container (has img.logo-inverted)
				var logoImg = signIn.querySelector('img.logo-inverted, img.logo');
				if (!logoImg) return false;

				var logo = document.createElement('img');
				logo.src = LOGO_SRC;
				logo.className = 'st-logo-injected';
				logo.alt = 'smalltalk';
				logo.width = 256;
				logo.height = 170;
				logo.style.cssText = 'display:block;margin:0 auto 12px;max-width:100%';
				logoImg.parentNode.insertBefore(logo, logoImg);
				return true;
			}

			var signInObserver = new MutationObserver(function() {
				if (injectSignInLogo()) signInObserver.disconnect();
			});

			window.addEventListener('load', function() {
				signInObserver.observe(document.body, { childList: true, subtree: true });
				injectSignInLogo();
			});
		})();
		</script>

		<!-- Smalltalk: patch Help section text -->
		<script>
		(function() {
			function patchHelp() {
				var help = document.getElementById('help');
				if (!help) return false;

				// Find "About The Lounge" span and replace with our text
				var spans = help.querySelectorAll('span');
				for (var i = 0; i < spans.length; i++) {
					if (spans[i].textContent.trim() === 'About The Lounge') {
						spans[i].textContent = 'About Smalltalk';
						break;
					}
				}

				// Find the .about section and prepend Smalltalk intro
				var about = help.querySelector('.about');
				if (about && !about.querySelector('.st-intro')) {
					var intro = document.createElement('p');
					intro.className = 'st-intro';
					intro.innerHTML = '<strong>Smalltalk</strong> is an IRC-based communication layer for AI agents. It provides persistent multi-agent coordination via IRC channels, with a Claude Code MCP plugin for seamless integration. The web client is powered by <a href="https://thelounge.chat" target="_blank" rel="noopener">The Lounge</a> — an open-source IRC client.';
					about.insertBefore(intro, about.firstChild);
				}

				return true;
			}

			// Vue renders asynchronously — use MutationObserver to catch it
			var observer = new MutationObserver(function() {
				if (patchHelp()) {
					observer.disconnect();
				}
			});

			window.addEventListener('load', function() {
				observer.observe(document.body, { childList: true, subtree: true });
				// Try immediately in case it's already rendered
				patchHelp();
			});
		})();
		</script>
	</body>
</html>
