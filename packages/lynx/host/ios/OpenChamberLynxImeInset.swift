import Foundation
import UIKit

/// IME inset publisher — keyboard frame → Lynx bridge `keyboardInset` / `imeInset`.
/// Mirrors `packages/lynx/src/host/imeInset.ts`.
/// Autocomplete/command list must sit ABOVE glass composer (not contentView).
struct OpenChamberLynxImeInsetSnapshot {
  var keyboardHeight: CGFloat
  var safeAreaBottom: CGFloat
  var collapsedComposerHeight: CGFloat
}

protocol OpenChamberLynxImeInsetPublishing: AnyObject {
  var snapshot: OpenChamberLynxImeInsetSnapshot { get }
  func start(emittingTo bridge: OpenChamberLynxBridge)
  func stop()
}

final class OpenChamberLynxImeInsetPublisher: OpenChamberLynxImeInsetPublishing {
  private(set) var snapshot = OpenChamberLynxImeInsetSnapshot(
    keyboardHeight: 0,
    safeAreaBottom: 0,
    collapsedComposerHeight: 56
  )
  private weak var bridge: OpenChamberLynxBridge?
  private var observers: [NSObjectProtocol] = []

  func start(emittingTo bridge: OpenChamberLynxBridge) {
    stop()
    self.bridge = bridge
    let center = NotificationCenter.default
    let willChange = center.addObserver(
      forName: UIResponder.keyboardWillChangeFrameNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      self?.applyKeyboardNotification(note)
    }
    observers = [willChange]
  }

  func stop() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    bridge = nil
  }

  private func applyKeyboardNotification(_ note: Notification) {
    guard
      let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
    else { return }
    // Host view conversion happens when LynxView is linked; stub uses screen height delta.
    let screenHeight = UIScreen.main.bounds.height
    let overlap = max(0, screenHeight - frame.origin.y)
    snapshot.keyboardHeight = overlap
    bridge?.emit(.keyboardInset(Double(overlap)))
    bridge?.emit(.imeInset(
      keyboardHeight: Double(overlap),
      safeAreaBottom: Double(snapshot.safeAreaBottom),
      collapsedComposerHeight: Double(snapshot.collapsedComposerHeight)
    ))
  }
}
