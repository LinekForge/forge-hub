import Cocoa
import WebKit
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "App")

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var window: NSWindow!
    var webView: WKWebView!
    var bridge: WebViewBridge!
    var refreshTimer: Timer?

    let terminal: TerminalAdapter = detectTerminal()
    let scanner = SessionScanner()
    let store = SessionStore()
    let descStore = SessionDescriptionStore()
    var hubClient: HubClient!
    private var isDevMode: Bool {
        ProcessInfo.processInfo.arguments.contains("--dev")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        descStore.load()
        store.loadStars()

        hubClient = HubClient(scanner: scanner)
        scanner.onEnrich = { [weak self] in
            self?.hubClient.enrichScanResults()
        }

        bridge = WebViewBridge(
            scanner: scanner,
            store: store,
            descStore: descStore,
            hubClient: hubClient,
            terminal: terminal
        )

        setupStatusItem()
        setupWindow()
        scanAndSync()

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.scanAndSync()
        }
    }

    // MARK: - Status Bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            if let iconPath = Bundle.main.path(forResource: "icon", ofType: "png"),
               let img = NSImage(contentsOfFile: iconPath) {
                img.isTemplate = true
                img.size = NSSize(width: 18, height: 18)
                button.image = img
            } else {
                button.title = "F"
            }
            button.action = #selector(toggleWindow)
            button.target = self
        }
    }

    // MARK: - Window + WebView

    private func setupWindow() {
        let contentController = WKUserContentController()
        contentController.add(bridge, name: "bridge")

        let preloadJS = """
        window.__nativeBridge = {
            _callbacks: {},
            _nextId: 0,
            call: function(action, params) {
                return new Promise(function(resolve, reject) {
                    var id = String(window.__nativeBridge._nextId++);
                    window.__nativeBridge._callbacks[id] = { resolve: resolve, reject: reject };
                    window.webkit.messageHandlers.bridge.postMessage({
                        action: action, callbackId: id, params: params || {}
                    });
                });
            },
            resolve: function(callbackId, result) {
                var cb = window.__nativeBridge._callbacks[callbackId];
                if (cb) { cb.resolve(result); delete window.__nativeBridge._callbacks[callbackId]; }
            },
            reject: function(callbackId, error) {
                var cb = window.__nativeBridge._callbacks[callbackId];
                if (cb) { cb.reject(new Error(error)); delete window.__nativeBridge._callbacks[callbackId]; }
            },
            onSessionsUpdated: function(sessions) {},
            onHubStatusChanged: function(online) {}
        };
        """
        let userScript = WKUserScript(source: preloadJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.preferences.setValue(isDevMode, forKey: "developerExtrasEnabled")
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        bridge.webView = webView

        let savedFrame = UserDefaults.standard.string(forKey: "windowFrame")
        let frame: NSRect
        if let savedFrame = savedFrame {
            frame = NSRectFromString(savedFrame)
        } else {
            frame = NSRect(x: 200, y: 200, width: 1200, height: 800)
        }

        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Forge Hub"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.delegate = self
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.031, green: 0.031, blue: 0.043, alpha: 1.0)

        loadDashboard()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func loadDashboard() {
        if isDevMode {
            webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))
            os_log("Loading dashboard from dev server (localhost:5173)", log: log, type: .info)
        } else if let distPath = Bundle.main.path(forResource: "index", ofType: "html", inDirectory: "dashboard-dist") {
            let distURL = URL(fileURLWithPath: distPath)
            let baseDir = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/dashboard-dist")
            webView.loadFileURL(distURL, allowingReadAccessTo: baseDir)
            os_log("Loading dashboard from bundle: %{public}@", log: log, type: .info, distPath)
        } else {
            let html = """
            <!doctype html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>
                html, body { margin: 0; height: 100%; background: #0b0b10; color: #f4f4f5; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; }
                body { display: grid; place-items: center; }
                main { width: min(560px, calc(100% - 48px)); padding: 24px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; background: rgba(255,255,255,.04); }
                h1 { margin: 0 0 10px; font-size: 20px; }
                p { margin: 0; color: #a1a1aa; line-height: 1.65; }
                code { color: #c7d2fe; }
              </style>
            </head>
            <body>
              <main>
                <h1>Dashboard bundle missing</h1>
                <p>Forge Hub Native Client 没有找到内嵌的 <code>dashboard-dist/index.html</code>。请重新运行 <code>hub-app/build.sh</code> 构建完整 app；开发模式可用 <code>--dev</code> 连接 localhost:5173。</p>
              </main>
            </body>
            </html>
            """
            webView.loadHTMLString(html, baseURL: nil)
            os_log("No bundled dashboard; fail-closed instead of loading localhost", log: log, type: .error)
        }
    }

    // MARK: - Toggle

    @objc func toggleWindow() {
        if window.isVisible {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return false
    }

    // MARK: - Scan

    func scanAndSync() {
        scanner.scanSessionsInBackground { [weak self] in
            self?.pushSessionsToWebView()
        }
    }

    func pushSessionsToWebView() {
        guard let bridge = bridge else { return }
        let sessions = bridge.buildNativeSessions()
        guard let data = try? JSONSerialization.data(withJSONObject: sessions),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "if(window.__nativeBridge&&window.__nativeBridge.onSessionsUpdated){window.__nativeBridge.onSessionsUpdated(\(json))}"
        webView.evaluateJavaScript(js, completionHandler: nil)

        let hubOnline = hubClient?.isHubOnline ?? false
        let statusJS = "if(window.__nativeBridge&&window.__nativeBridge.onHubStatusChanged){window.__nativeBridge.onHubStatusChanged(\(hubOnline))}"
        webView.evaluateJavaScript(statusJS, completionHandler: nil)
    }
}

// MARK: - NSWindowDelegate

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: "windowFrame")
    }

    func windowDidResize(_ notification: Notification) {
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: "windowFrame")
    }
}
