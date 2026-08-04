import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var readinessURL: URL?
    private var logHandle: FileHandle?
    private var startupComplete = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        NSApp.setActivationPolicy(.regular)

        guard let serverURL = Bundle.main.url(
            forResource: "euphony-server",
            withExtension: nil
        ) else {
            showStartupFailure("The bundled Euphony server is missing.")
            return
        }

        let token = "\(UUID().uuidString)-\(UUID().uuidString)"
        let readinessURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("euphony-\(UUID().uuidString).ready")
        let configuration = ServerLaunchConfiguration(
            serverURL: serverURL,
            readyFileURL: readinessURL,
            token: token
        )
        self.readinessURL = readinessURL

        let process = Process()
        process.executableURL = configuration.serverURL
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.environment = configuration.environment
        let logHandle = makeLogHandle()
        self.logHandle = logHandle
        process.standardOutput = logHandle ?? FileHandle.nullDevice
        process.standardError = logHandle ?? FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.serverDidTerminate()
            }
        }

        do {
            try process.run()
        } catch {
            showStartupFailure("The bundled Euphony server could not be started: \(error.localizedDescription)")
            return
        }
        serverProcess = process
        waitForReadiness(configuration: configuration, token: token)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        cleanupServer()
    }

    private func waitForReadiness(
        configuration: ServerLaunchConfiguration,
        token: String
    ) {
        let readinessURL = configuration.readyFileURL
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                if let data = try? Data(contentsOf: readinessURL),
                   let text = String(data: data, encoding: .utf8),
                   let baseURL = Self.parseBaseURL(text) {
                    DispatchQueue.main.async {
                        self?.showWorkspace(baseURL: baseURL, token: token)
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.05)
            }

            DispatchQueue.main.async {
                self?.showStartupFailure("The Euphony server did not become ready within 10 seconds.")
            }
        }
    }

    private static func parseBaseURL(_ text: String) -> URL? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              url.scheme == "http",
              url.host == "127.0.0.1",
              url.port != nil,
              url.path.isEmpty || url.path == "/" else {
            return nil
        }
        return url
    }

    private func showWorkspace(baseURL: URL, token: String) {
        guard !startupComplete else { return }
        guard var components = URLComponents(
            url: baseURL,
            resolvingAgainstBaseURL: false
        ) else {
            showStartupFailure("The Euphony server published an invalid URL.")
            return
        }
        components.queryItems = (components.queryItems ?? []) + [
            URLQueryItem(name: "token", value: token)
        ]
        guard let workspaceURL = components.url else {
            showStartupFailure("The Euphony server published an invalid URL.")
            return
        }

        startupComplete = true
        let browser = FinderDropWebView(
            frame: .zero,
            configuration: WKWebViewConfiguration()
        )
        browser.autoresizingMask = [.width, .height]
        webView = browser

        let contentRect = NSRect(x: 0, y: 0, width: 1280, height: 820)
        let window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Euphony"
        window.minSize = NSSize(width: 640, height: 480)
        window.contentView = browser
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        browser.load(URLRequest(url: workspaceURL))
    }

    private func serverDidTerminate() {
        guard !startupComplete else { return }
        showStartupFailure("The Euphony server exited before the workspace was ready.")
    }

    private func showStartupFailure(_ message: String) {
        guard !startupComplete else { return }
        startupComplete = true
        cleanupServer()

        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Euphony could not start"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func cleanupServer() {
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
        serverProcess = nil
        if let readinessURL {
            try? FileManager.default.removeItem(at: readinessURL)
        }
        try? logHandle?.close()
        logHandle = nil
    }

    private func makeLogHandle() -> FileHandle? {
        let fileManager = FileManager.default
        guard let libraryURL = fileManager.urls(
            for: .libraryDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }
        let directoryURL = libraryURL.appendingPathComponent(
            "Logs/Euphony",
            isDirectory: true
        )
        do {
            try fileManager.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true
            )
            let logURL = directoryURL.appendingPathComponent("app.log")
            if !fileManager.fileExists(atPath: logURL.path) {
                fileManager.createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            return handle
        } catch {
            return nil
        }
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu(title: "Euphony")
        applicationMenu.addItem(
            withTitle: "About Euphony",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "Quit Euphony",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.miniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }
}

@main
struct EuphonyApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
