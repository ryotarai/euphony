import AppKit
import Foundation
import WebKit

func browserClientPoint(from point: NSPoint, in view: NSView) -> NSPoint {
    guard !view.isFlipped else { return point }
    return NSPoint(x: point.x, y: view.bounds.height - point.y)
}

func localFilePaths(from urls: [URL]) -> [String] {
    urls.compactMap { url in
        guard url.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost" else {
            return nil
        }
        return url.path
    }
}

func fileDropJavaScript(
    paths: [String],
    clientX: Double,
    clientY: Double
) -> String? {
    guard !paths.isEmpty else { return nil }
    let payload: [String: Any] = [
        "paths": paths,
        "clientX": clientX,
        "clientY": clientY,
    ]
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else {
        return nil
    }
    return """
    (() => {
      const drop = \(json);
      const target = document
        .elementFromPoint(drop.clientX, drop.clientY)
        ?.closest(".terminal-host");
      if (!target) return false;
      return target.dispatchEvent(new CustomEvent("euphony-file-drop", {
        bubbles: true,
        cancelable: true,
        detail: { paths: drop.paths },
      }));
    })()
    """
}

final class FinderDropWebView: WKWebView {
    override init(frame: NSRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        filePaths(from: sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        filePaths(from: sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        !filePaths(from: sender).isEmpty || super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let paths = filePaths(from: sender)
        guard !paths.isEmpty else {
            return super.performDragOperation(sender)
        }
        let point = browserClientPoint(
            from: convert(sender.draggingLocation, from: nil),
            in: self
        )
        guard let script = fileDropJavaScript(
            paths: paths,
            clientX: point.x,
            clientY: point.y
        ) else {
            return false
        }
        evaluateJavaScript(script)
        return true
    }

    private func filePaths(from sender: NSDraggingInfo) -> [String] {
        let objects = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) ?? []
        return localFilePaths(from: objects.compactMap { $0 as? URL })
    }
}
