import UIKit

/// Host chrome for the Lynx phone shell.
///
/// Mode B (iOS 26+): `UITabBarController` owns the four-tab dock
/// (Projects / Assistant / Scheduled / Settings). Chat is a pushed
/// full-screen LynxView and **hides** this tab bar.
///
/// Mode A (older iOS): a single full-screen LynxView; Lynx paints the dock
/// with `<blur-view>`. This controller must not install a second `UITabBar`.
///
/// Native code never owns the Lynx page stack. Tab taps emit `tabSelected`.
///
/// Requires Lynx 4.x (`pod 'Lynx'`) before this file can compile in Xcode.
/// This slice lands the embedding strategy, not a signed IPA.
final class OpenChamberLynxHostController: UITabBarController, UITabBarControllerDelegate {
  private let decision = OpenChamberLynxEmbedding.resolve()
  private let tabIds = ["projects", "assistant", "scheduled", "settings"]

  override func viewDidLoad() {
    super.viewDidLoad()
    delegate = self
    if decision.mode == .hostChrome {
      installHostTabs()
    } else {
      installFullPageLynx()
    }
  }

  private func installHostTabs() {
    viewControllers = tabIds.map { tabId in
      let page = OpenChamberLynxTabPageController(tabId: tabId, embeddingMode: decision.mode)
      page.tabBarItem = UITabBarItem(title: tabId, image: nil, selectedImage: nil)
      page.tabBarItem.tag = tabIds.firstIndex(of: tabId) ?? 0
      return page
    }
    // Chat is never a tab item.
  }

  private func installFullPageLynx() {
    // Mode A: hide the system tab bar so Lynx glass/blur dock is the only chrome.
    tabBar.isHidden = true
    viewControllers = [OpenChamberLynxTabPageController(tabId: "projects", embeddingMode: decision.mode)]
  }

  func hideTabChromeForSecondaryPage() {
    tabBar.isHidden = true
  }

  func showTabChromeIfHostOwned() {
    tabBar.isHidden = !OpenChamberLynxEmbedding.shouldShowHostTabChrome(
      decision: decision,
      secondaryVisible: false,
      overlayActive: false
    )
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
    // Emit tabSelected; Lynx/JS still commits the selected id.
    return true
  }
}

/// Content LynxView for one root tab. Host sizes this to the remaining slot
/// (`auto-height` / `auto-width` on the Lynx `<page>`).
final class OpenChamberLynxTabPageController: UIViewController {
  let tabId: String
  let embeddingMode: OpenChamberLynxEmbeddingMode

  init(tabId: String, embeddingMode: OpenChamberLynxEmbeddingMode) {
    self.tabId = tabId
    self.embeddingMode = embeddingMode
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    // OpenChamberLynxViewFactory.makeContentView(tabId:tabId, mode:embeddingMode)
  }
}
