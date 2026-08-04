import Foundation
import AppKit

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

@main
struct FileDropBridgeTests {
    static func main() {
        let script = fileDropJavaScript(
            paths: ["/tmp/first file.txt", "/tmp/O'Brien\nfile.txt"],
            clientX: 12.5,
            clientY: 34.25
        )

        expect(script != nil, "local paths should produce a dispatch script")
        expect(
            script?.contains("\"paths\":[\"\\/tmp\\/first file.txt\",\"\\/tmp\\/O'Brien\\nfile.txt\"]") == true,
            "paths should be JSON encoded without executable interpolation"
        )
        expect(
            script?.contains(".elementFromPoint(drop.clientX, drop.clientY)") == true,
            "the script should target the terminal under the drop point"
        )
        expect(
            script?.contains("closest(\".terminal-host\")") == true,
            "the script should dispatch only to a terminal host"
        )
        expect(
            script?.contains("new CustomEvent(\"euphony-file-drop\"") == true,
            "the script should use the web terminal drop contract"
        )
        expect(
            fileDropJavaScript(paths: [], clientX: 0, clientY: 0) == nil,
            "an empty path list should not produce a script"
        )

        let flippedView = FlippedTestView(
            frame: NSRect(x: 0, y: 0, width: 100, height: 80)
        )
        expect(
            browserClientPoint(
                from: NSPoint(x: 12, y: 25),
                in: flippedView
            ) == NSPoint(x: 12, y: 25),
            "a flipped web view coordinate should not be inverted again"
        )
        expect(
            localFilePaths(from: [
                URL(fileURLWithPath: "/tmp/local.txt"),
                URL(string: "file://localhost/tmp/localhost.txt")!,
                URL(string: "file://server/share/remote.txt")!,
                URL(string: "https://example.com/file.txt")!,
            ]) == ["/tmp/local.txt", "/tmp/localhost.txt"],
            "only local file hosts should cross the bridge"
        )

        print("File drop bridge tests passed")
    }
}

private final class FlippedTestView: NSView {
    override var isFlipped: Bool { true }
}
