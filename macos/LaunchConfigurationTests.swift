import Foundation

@main
struct LaunchConfigurationTests {
    static func main() {
        let serverURL = URL(fileURLWithPath: "/Applications/Euphony.app/Contents/Resources/euphony-server")
        let readyFileURL = URL(fileURLWithPath: "/tmp/euphony-test/ready")
        let configuration = ServerLaunchConfiguration(
            serverURL: serverURL,
            readyFileURL: readyFileURL,
            token: "test-token",
            inheritedEnvironment: ["KEEP_ME": "yes"]
        )

        precondition(configuration.serverURL == serverURL)
        precondition(configuration.readyFileURL == readyFileURL)
        precondition(configuration.environment["KEEP_ME"] == "yes")
        precondition(configuration.environment["EUPHONY_ADDR"] == "127.0.0.1:0")
        precondition(configuration.environment["EUPHONY_TOKEN"] == "test-token")
        precondition(configuration.environment["EUPHONY_READY_FILE"] == readyFileURL.path)
        print("launch configuration passed")
    }
}
