import AppKit
import CoreGraphics
import ApplicationServices

// Local GUI smoke helper: observe only this launcher's own window metadata.
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let matches = windows.filter { ($0[kCGWindowOwnerName as String] as? String) == "AgentCollabHub" }
let records = matches.compactMap { window -> [String: Any]? in
    guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let id = window[kCGWindowNumber as String] as? Int,
          let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { return nil }
    return ["windowId": id, "bounds": bounds, "title": window[kCGWindowName as String] as? String ?? ""]
}
var result: [String: Any] = ["screenRecordingWindows": records, "screenRecordingAllowed": CGPreflightScreenCaptureAccess()]
if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "local.agentcollabhub.launcher" }) {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success,
       let windows = value as? [AXUIElement] {
        result["accessibilityWindows"] = windows.map { window -> [String: Any] in
            var title: CFTypeRef?
            AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title)
            return ["title": title as? String ?? ""]
        }
    }
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
