import ExpoModulesCore
import UIKit

/**
 Native chat composer field: UITextView owns IME.

 Glass chrome stays in RN (`GlassComposerShell` / expo-glass-effect). Autocomplete
 stays in RN above the card — do not mount slash glyphs inside UIGlassEffect
 contentView (missing glyphs). Occupancy events report collapsed line height only.
 */
public final class NativeComposerTextView: ExpoView, UITextViewDelegate {
  let onChangeText = EventDispatcher()
  let onFocus = EventDispatcher()
  let onBlur = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onCollapsedHeightChange = EventDispatcher()
  let onContentSizeChange = EventDispatcher()
  let onSelectionChange = EventDispatcher()

  private let textView = UITextView()
  private let placeholderLabel = UILabel()
  private var lastEmittedText: String = ""
  private var lastCollapsedHeight: CGFloat = -1
  private var lastContentHeight: CGFloat = -1
  private var isSettingText = false
  private var textHeightConstraint: NSLayoutConstraint?

  var placeholderText: String = "" {
    didSet { refreshPlaceholder() }
  }

  var maxContentHeight: CGFloat = 120 {
    didSet { relayoutContentHeight(force: true) }
  }

  /// Occupancy token — single-line collapsed height; expand must not raise accessories.
  var collapsedLineHeight: CGFloat = 40 {
    didSet { emitCollapsedHeight(force: true) }
  }

  var textColorValue: UIColor = .label {
    didSet {
      textView.textColor = textColorValue
    }
  }

  var placeholderColorValue: UIColor = .secondaryLabel {
    didSet {
      placeholderLabel.textColor = placeholderColorValue
    }
  }

  var fontSizeValue: CGFloat = 16 {
    didSet {
      let font = UIFont.systemFont(ofSize: fontSizeValue)
      textView.font = font
      placeholderLabel.font = font
      relayoutContentHeight(force: true)
      emitCollapsedHeight(force: true)
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear

    textView.translatesAutoresizingMaskIntoConstraints = false
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
    textView.textContainer.lineFragmentPadding = 0
    textView.font = .systemFont(ofSize: fontSizeValue)
    textView.textColor = textColorValue
    textView.delegate = self
    textView.returnKeyType = .default
    textView.enablesReturnKeyAutomatically = false
    textView.tintColor = .label
    textView.isScrollEnabled = false
    textView.keyboardDismissMode = .interactive

    placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
    placeholderLabel.font = .systemFont(ofSize: fontSizeValue)
    placeholderLabel.textColor = placeholderColorValue
    placeholderLabel.numberOfLines = 1
    placeholderLabel.isUserInteractionEnabled = false

    addSubview(textView)
    addSubview(placeholderLabel)

    let height = textView.heightAnchor.constraint(equalToConstant: collapsedLineHeight)
    height.priority = .required
    textHeightConstraint = height

    NSLayoutConstraint.activate([
      textView.topAnchor.constraint(equalTo: topAnchor),
      textView.leadingAnchor.constraint(equalTo: leadingAnchor),
      textView.trailingAnchor.constraint(equalTo: trailingAnchor),
      textView.bottomAnchor.constraint(equalTo: bottomAnchor),
      height,
      placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 4),
      placeholderLabel.trailingAnchor.constraint(equalTo: textView.trailingAnchor, constant: -4),
      placeholderLabel.centerYAnchor.constraint(equalTo: textView.centerYAnchor),
    ])

    emitCollapsedHeight(force: true)
  }

  func setText(_ value: String?) {
    let next = value ?? ""
    if textView.text == next { return }
    isSettingText = true
    textView.text = next
    lastEmittedText = next
    isSettingText = false
    refreshPlaceholder()
    relayoutContentHeight(force: true)
    emitCollapsedHeight(force: false)
  }

  func setEditable(_ value: Bool?) {
    textView.isEditable = value ?? true
    textView.isSelectable = true
  }

  func focus() {
    textView.becomeFirstResponder()
  }

  func blur() {
    textView.resignFirstResponder()
  }

  private func refreshPlaceholder() {
    placeholderLabel.text = placeholderText
    placeholderLabel.isHidden = !(textView.text ?? "").isEmpty
  }

  @discardableResult
  private func relayoutContentHeight(force: Bool = false) -> Bool {
    let width = max(bounds.width, textView.bounds.width, 120)
    let fitting = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    let minHeight = collapsedLineHeight
    let next = min(max(fitting.height, minHeight), maxContentHeight)
    let changed = force || abs(next - (textHeightConstraint?.constant ?? -1)) > 0.5
    if changed {
      textHeightConstraint?.constant = next
      textView.isScrollEnabled = fitting.height > maxContentHeight
      invalidateIntrinsicContentSize()
      setNeedsLayout()
    }
    if force || abs(next - lastContentHeight) > 0.5 {
      lastContentHeight = next
      onContentSizeChange([
        "width": Double(width),
        "height": Double(next),
      ])
    }
    return changed
  }

  private func emitCollapsedHeight(force: Bool) {
    let height = collapsedLineHeight
    if !force && abs(height - lastCollapsedHeight) <= 0.5 { return }
    lastCollapsedHeight = height
    onCollapsedHeightChange(["height": Double(height)])
  }

  private func emitTextAndSelection() {
    let text = textView.text ?? ""
    let range = textView.selectedRange
    lastEmittedText = text
    onChangeText([
      "text": text,
      "selectionStart": range.location,
      "selectionEnd": range.location + range.length,
    ])
    onSelectionChange([
      "start": range.location,
      "end": range.location + range.length,
    ])
  }

  public override var intrinsicContentSize: CGSize {
    let width = bounds.width > 0 ? bounds.width : UIView.noIntrinsicMetric
    let height = textHeightConstraint?.constant ?? collapsedLineHeight
    return CGSize(width: width, height: height)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    relayoutContentHeight(force: false)
  }

  // MARK: - UITextViewDelegate

  public func textViewDidBeginEditing(_ textView: UITextView) {
    onFocus([:])
    // Freeze occupancy at collapsed while focused/expanded — accessories stay put.
    emitCollapsedHeight(force: true)
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onBlur([:])
    relayoutContentHeight(force: true)
    emitCollapsedHeight(force: true)
  }

  public func textViewDidChange(_ textView: UITextView) {
    if isSettingText { return }
    refreshPlaceholder()
    relayoutContentHeight(force: false)
    // Occupancy stays collapsed even when content grows.
    emitCollapsedHeight(force: false)
    emitTextAndSelection()
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    if isSettingText { return }
    let range = textView.selectedRange
    onSelectionChange([
      "start": range.location,
      "end": range.location + range.length,
    ])
  }

  public func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    // Soft submit hook for single-line callers; Chat uses multiline + Send button.
    if text == "\n", textView.textContainer.maximumNumberOfLines == 1 {
      onSubmit(["text": textView.text ?? ""])
      return false
    }
    return true
  }
}
