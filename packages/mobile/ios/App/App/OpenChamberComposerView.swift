import UIKit

protocol OpenChamberComposerViewDelegate: AnyObject {
    func composerViewDidChangeText(_ view: OpenChamberComposerView, text: String)
    func composerViewDidRequestSend(_ view: OpenChamberComposerView, text: String)
    func composerViewDidRequestAbort(_ view: OpenChamberComposerView)
    func composerViewDidRequestAttach(_ view: OpenChamberComposerView)
    func composerViewDidRequestModel(_ view: OpenChamberComposerView)
    func composerViewDidChangeExpanded(_ view: OpenChamberComposerView, expanded: Bool)
    func composerViewDidChangeHeight(_ view: OpenChamberComposerView)
}

/// Floating iOS chat composer: collapsed glass pill, expanded glass card.
/// iOS 26 uses `UIGlassEffect` when the class exists; older systems use material blur.
final class OpenChamberComposerView: UIView, UITextViewDelegate {
    weak var delegate: OpenChamberComposerViewDelegate?

    private let collapsedPlus = OpenChamberComposerView.makeCircleButton(systemName: "plus")
    private let card = GlassBackdropView()
    private let attachmentChip = UIButton(type: .system)
    private let textView = UITextView()
    private let placeholderLabel = UILabel()
    private let modelButton = UIButton(type: .system)
    private let sendButton = OpenChamberComposerView.makeCircleButton(systemName: "arrow.up")
    private let expandedPlus = OpenChamberComposerView.makeCircleButton(systemName: "plus")
    private let footer = UIStackView()

    private var textHeightConstraint: NSLayoutConstraint?
    private var expandedFooterConstraints: [NSLayoutConstraint] = []
    private var collapsedFooterConstraints: [NSLayoutConstraint] = []
    private var attachmentHeightConstraint: NSLayoutConstraint?

    private var isExpanded = false
    private var canSend = false
    private var canAbort = false
    private var attachmentCount = 0
    private var applyingExternalText = false
    private var appearanceIsDark = true
    private var placeholderText = "Tap to type"
    private var attachAria = "Attach files"
    private var sendAria = "Send message"
    private var stopAria = "Stop generating"
    private var modelAria = "Select model"

    var currentText: String { textView.text ?? "" }

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        isOpaque = false
        backgroundColor = .clear
        build()
        applyAppearance()
        setExpanded(false, animated: false)
        refreshSendButton()
        refreshPlaceholder()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func applyState(
        text: String?,
        placeholder: String?,
        modelLabel: String?,
            canSend nextCanSend: Bool,
            canAbort nextCanAbort: Bool,
            attachmentCount nextAttachmentCount: Int,
        appearance: String?,
        attachAria: String?,
        sendAria: String?,
        stopAria: String?,
        modelAria: String?
    ) {
        if let placeholder { placeholderText = placeholder }
        if let attachAria { self.attachAria = attachAria }
        if let sendAria { self.sendAria = sendAria }
        if let stopAria { self.stopAria = stopAria }
        if let modelAria { self.modelAria = modelAria }
        collapsedPlus.accessibilityLabel = self.attachAria
        expandedPlus.accessibilityLabel = self.attachAria
        modelButton.accessibilityLabel = self.modelAria

        canSend = nextCanSend
        canAbort = nextCanAbort
        attachmentCount = nextAttachmentCount
        if let appearance {
            appearanceIsDark = appearance != "light"
            applyAppearance()
        }
        if let text, text != textView.text {
            applyingExternalText = true
            textView.text = text
            applyingExternalText = false
            refreshPlaceholder()
            relayoutTextHeight()
        }
        if let modelLabel {
            var config = UIButton.Configuration.plain()
            config.title = modelLabel
            config.image = UIImage(systemName: "chevron.down")
            config.imagePlacement = .trailing
            config.imagePadding = 4
            config.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = .systemFont(ofSize: 12, weight: .semibold)
                outgoing.foregroundColor = self.appearanceIsDark
                    ? UIColor.white.withAlphaComponent(0.86)
                    : UIColor.black.withAlphaComponent(0.78)
                return outgoing
            }
            config.baseForegroundColor = appearanceIsDark
                ? UIColor.white.withAlphaComponent(0.7)
                : UIColor.black.withAlphaComponent(0.55)
            modelButton.configuration = config
            modelButton.isHidden = !isExpanded || modelLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        refreshAttachmentChip()
        refreshSendButton()
    }

    func setSuppressed(_ suppressed: Bool) {
        isHidden = suppressed
        if suppressed {
            textView.resignFirstResponder()
        }
        delegate?.composerViewDidChangeHeight(self)
    }

    func focusInput() {
        guard !isHidden else { return }
        textView.becomeFirstResponder()
    }

    func blurInput() {
        textView.resignFirstResponder()
    }

    // MARK: - Build

    private func build() {
        collapsedPlus.addTarget(self, action: #selector(attachTapped), for: .touchUpInside)
        collapsedPlus.layer.cornerRadius = 18
        expandedPlus.addTarget(self, action: #selector(attachTapped), for: .touchUpInside)
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        modelButton.addTarget(self, action: #selector(modelTapped), for: .touchUpInside)

        modelButton.translatesAutoresizingMaskIntoConstraints = false
        modelButton.layer.cornerRadius = 14
        modelButton.clipsToBounds = true
        modelButton.backgroundColor = UIColor.black.withAlphaComponent(0.28)

        attachmentChip.translatesAutoresizingMaskIntoConstraints = false
        attachmentChip.titleLabel?.font = .systemFont(ofSize: 12, weight: .medium)
        attachmentChip.contentHorizontalAlignment = .left
        attachmentChip.isHidden = true
        attachmentChip.isUserInteractionEnabled = false

        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.delegate = self
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 4, bottom: 8, right: 4)
        textView.textContainer.lineFragmentPadding = 4
        textView.font = .systemFont(ofSize: 16)
        textView.adjustsFontForContentSizeCategory = true
        textView.isScrollEnabled = false
        textView.keyboardDismissMode = .interactive
        textView.returnKeyType = .default
        textView.tintColor = .label

        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        placeholderLabel.font = .systemFont(ofSize: 16)
        placeholderLabel.numberOfLines = 1

        footer.axis = .horizontal
        footer.alignment = .center
        footer.spacing = 8
        footer.translatesAutoresizingMaskIntoConstraints = false
        footer.addArrangedSubview(expandedPlus)
        footer.addArrangedSubview(modelButton)
        footer.addArrangedSubview(UIView())

        addSubview(collapsedPlus)
        addSubview(card)
        card.contentView.addSubview(attachmentChip)
        card.contentView.addSubview(textView)
        card.contentView.addSubview(placeholderLabel)
        card.contentView.addSubview(footer)
        card.contentView.addSubview(sendButton)

        collapsedPlus.translatesAutoresizingMaskIntoConstraints = false
        expandedPlus.translatesAutoresizingMaskIntoConstraints = false
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        let textHeight = textView.heightAnchor.constraint(equalToConstant: 36)
        textHeight.priority = .defaultHigh
        textHeightConstraint = textHeight
        let attachmentHeight = attachmentChip.heightAnchor.constraint(equalToConstant: 0)
        attachmentHeightConstraint = attachmentHeight

        NSLayoutConstraint.activate([
            collapsedPlus.leadingAnchor.constraint(equalTo: leadingAnchor),
            collapsedPlus.centerYAnchor.constraint(equalTo: card.centerYAnchor),
            collapsedPlus.widthAnchor.constraint(equalToConstant: 36),
            collapsedPlus.heightAnchor.constraint(equalToConstant: 36),

            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),

            attachmentChip.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 8),
            attachmentChip.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 14),
            attachmentChip.trailingAnchor.constraint(lessThanOrEqualTo: card.contentView.trailingAnchor, constant: -14),
            attachmentHeight,

            textView.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 8),
            textHeight,

            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 8),
            placeholderLabel.trailingAnchor.constraint(equalTo: textView.trailingAnchor, constant: -8),
            placeholderLabel.centerYAnchor.constraint(equalTo: textView.centerYAnchor),

            expandedPlus.widthAnchor.constraint(equalToConstant: 32),
            expandedPlus.heightAnchor.constraint(equalToConstant: 32),
            sendButton.widthAnchor.constraint(equalToConstant: 32),
            sendButton.heightAnchor.constraint(equalToConstant: 32),
            modelButton.heightAnchor.constraint(equalToConstant: 28),
            modelButton.widthAnchor.constraint(lessThanOrEqualToConstant: 220),
        ])

        collapsedFooterConstraints = [
            card.leadingAnchor.constraint(equalTo: collapsedPlus.trailingAnchor, constant: 8),
            textView.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 2),
            textView.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -2),
            textView.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -4),
            sendButton.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -8),
            sendButton.centerYAnchor.constraint(equalTo: card.contentView.centerYAnchor),
            footer.heightAnchor.constraint(equalToConstant: 0),
        ]
        expandedFooterConstraints = [
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            textView.topAnchor.constraint(equalTo: attachmentChip.bottomAnchor, constant: 2),
            textView.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -8),
            footer.topAnchor.constraint(equalTo: textView.bottomAnchor, constant: 4),
            footer.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 10),
            footer.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            footer.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -10),
            sendButton.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -10),
            sendButton.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -10),
        ]

        let tap = UITapGestureRecognizer(target: self, action: #selector(cardTapped))
        tap.cancelsTouchesInView = false
        card.addGestureRecognizer(tap)
    }

    private func setExpanded(_ expanded: Bool, animated: Bool) {
        let changed = isExpanded != expanded
        isExpanded = expanded
        collapsedPlus.isHidden = expanded
        expandedPlus.isHidden = !expanded
        modelButton.isHidden = !expanded || (modelButton.configuration?.title?.isEmpty ?? true)
        footer.isHidden = !expanded
        refreshAttachmentChip()
        textView.textContainer.maximumNumberOfLines = expanded ? 0 : 1
        textView.isScrollEnabled = expanded
        card.layer.cornerRadius = expanded ? 22 : 24

        collapsedFooterConstraints.forEach { $0.isActive = !expanded }
        expandedFooterConstraints.forEach { $0.isActive = expanded }
        relayoutTextHeight()

        let apply = {
            self.layoutIfNeeded()
            self.delegate?.composerViewDidChangeHeight(self)
        }
        if animated {
            UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseInOut, .allowUserInteraction], animations: apply)
        } else {
            apply()
        }
        if changed {
            delegate?.composerViewDidChangeExpanded(self, expanded: expanded)
        }
    }

    private func relayoutTextHeight() {
        let maxHeight: CGFloat = isExpanded ? 120 : 36
        let minHeight: CGFloat = isExpanded ? 44 : 36
        let size = textView.sizeThatFits(CGSize(width: max(textView.bounds.width, 120), height: .greatestFiniteMagnitude))
        textHeightConstraint?.constant = min(max(size.height, minHeight), maxHeight)
        textView.isScrollEnabled = isExpanded && size.height > maxHeight
    }

    private func refreshPlaceholder() {
        placeholderLabel.text = placeholderText
        placeholderLabel.isHidden = !(textView.text ?? "").isEmpty
    }

    private func refreshAttachmentChip() {
        let visible = isExpanded && attachmentCount > 0
        attachmentChip.isHidden = !visible
        attachmentHeightConstraint?.constant = visible ? 22 : 0
        if visible {
            attachmentChip.setImage(UIImage(systemName: "paperclip"), for: .normal)
            attachmentChip.setTitle("\(attachmentCount)", for: .normal)
        }
    }

    private func refreshSendButton() {
        let symbol = canAbort ? "stop.fill" : "arrow.up"
        let enabled = canAbort || canSend
        sendButton.setImage(UIImage(systemName: symbol), for: .normal)
        sendButton.accessibilityLabel = canAbort ? stopAria : sendAria
        sendButton.alpha = enabled ? 1 : 0.38
        sendButton.isEnabled = enabled
        sendButton.backgroundColor = appearanceIsDark ? UIColor.white : UIColor.black
        sendButton.tintColor = appearanceIsDark ? UIColor.black : UIColor.white
    }

    private func applyAppearance() {
        let label = appearanceIsDark ? UIColor.white : UIColor.black
        textView.textColor = label
        placeholderLabel.textColor = label.withAlphaComponent(0.45)
        attachmentChip.setTitleColor(label.withAlphaComponent(0.7), for: .normal)
        card.appearanceIsDark = appearanceIsDark
        collapsedPlus.backgroundColor = appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.12)
            : UIColor.black.withAlphaComponent(0.08)
        collapsedPlus.tintColor = label
        expandedPlus.backgroundColor = collapsedPlus.backgroundColor
        expandedPlus.tintColor = label
        modelButton.backgroundColor = appearanceIsDark
            ? UIColor.black.withAlphaComponent(0.32)
            : UIColor.white.withAlphaComponent(0.45)
        refreshSendButton()
        card.refreshEffect()
    }

    @objc private func attachTapped() {
        delegate?.composerViewDidRequestAttach(self)
    }

    @objc private func modelTapped() {
        textView.resignFirstResponder()
        delegate?.composerViewDidRequestModel(self)
    }

    @objc private func sendTapped() {
        if canAbort {
            delegate?.composerViewDidRequestAbort(self)
            return
        }
        guard canSend else { return }
        delegate?.composerViewDidRequestSend(self, text: currentText)
    }

    @objc private func cardTapped() {
        if !isExpanded {
            textView.becomeFirstResponder()
        }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        setExpanded(true, animated: true)
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        setExpanded(false, animated: true)
    }

    func textViewDidChange(_ textView: UITextView) {
        refreshPlaceholder()
        relayoutTextHeight()
        delegate?.composerViewDidChangeHeight(self)
        guard !applyingExternalText else { return }
        delegate?.composerViewDidChangeText(self, text: textView.text ?? "")
    }

    private static func makeCircleButton(systemName: String) -> UIButton {
        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setImage(UIImage(systemName: systemName), for: .normal)
        button.layer.cornerRadius = 16
        button.clipsToBounds = true
        button.tintColor = .label
        return button
    }
}

private final class GlassBackdropView: UIView {
    var appearanceIsDark = true { didSet { refreshEffect() } }

    let contentView = UIView()
    private let blurView = UIVisualEffectView(effect: nil)

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        layer.cornerCurve = .continuous
        layer.cornerRadius = 24
        clipsToBounds = true
        blurView.translatesAutoresizingMaskIntoConstraints = false
        contentView.translatesAutoresizingMaskIntoConstraints = false
        contentView.backgroundColor = .clear
        addSubview(blurView)
        addSubview(contentView)
        NSLayoutConstraint.activate([
            blurView.topAnchor.constraint(equalTo: topAnchor),
            blurView.bottomAnchor.constraint(equalTo: bottomAnchor),
            blurView.leadingAnchor.constraint(equalTo: leadingAnchor),
            blurView.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentView.topAnchor.constraint(equalTo: topAnchor),
            contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        refreshEffect()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func refreshEffect() {
        if let glass = Self.makeGlassEffect() {
            blurView.effect = glass
            backgroundColor = .clear
            layer.borderWidth = 0
            return
        }
        let style: UIBlurEffect.Style = appearanceIsDark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight
        blurView.effect = UIBlurEffect(style: style)
        backgroundColor = appearanceIsDark
            ? UIColor.black.withAlphaComponent(0.18)
            : UIColor.white.withAlphaComponent(0.22)
        layer.borderWidth = 0.5
        layer.borderColor = (appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.16)
            : UIColor.white.withAlphaComponent(0.55)).cgColor
    }

    private static func makeGlassEffect() -> UIVisualEffect? {
        guard let effectClass = NSClassFromString("UIGlassEffect") as? NSObject.Type else {
            return nil
        }
        let effect = effectClass.init()
        if effect.responds(to: NSSelectorFromString("setInteractive:")) {
            effect.setValue(true, forKey: "interactive")
        }
        return effect as? UIVisualEffect
    }
}
