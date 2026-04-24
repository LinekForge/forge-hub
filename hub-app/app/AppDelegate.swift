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
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

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
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--dev") {
            webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))
            os_log("Loading dashboard from dev server (localhost:5173)", log: log, type: .info)
        } else if args.contains("--hub") {
            webView.load(URLRequest(url: URL(string: "http://localhost:9900")!))
            os_log("Loading dashboard from Hub server (localhost:9900)", log: log, type: .info)
        } else if let distPath = Bundle.main.path(forResource: "index", ofType: "html", inDirectory: "dashboard-dist") {
            let distURL = URL(fileURLWithPath: distPath)
            let distDir = distURL.deletingLastPathComponent()
            webView.loadFileURL(distURL, allowingReadAccessTo: distDir)
            os_log("Loading dashboard from bundle", log: log, type: .info)
        } else {
            webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))
            os_log("No bundled dashboard found, falling back to dev server", log: log, type: .info)
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
