import Foundation

struct ServerLaunchConfiguration {
    let serverURL: URL
    let readyFileURL: URL
    let environment: [String: String]

    init(
        serverURL: URL,
        readyFileURL: URL,
        token: String,
        inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.serverURL = serverURL
        self.readyFileURL = readyFileURL

        var environment = inheritedEnvironment
        environment["EUPHONY_ADDR"] = "127.0.0.1:0"
        environment["EUPHONY_TOKEN"] = token
        environment["EUPHONY_READY_FILE"] = readyFileURL.path
        environment["EUPHONY_SOCKET"] = readyFileURL
            .deletingLastPathComponent()
            .appendingPathComponent("euphony.sock")
            .path
        self.environment = environment
    }
}
