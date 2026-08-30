import UIKit

protocol OpenChamberComposerViewDelegate: AnyObject {
    func composerViewDidChangeText(_ view: OpenChamberComposerView, text: String, selectionStart: Int, selectionEnd: Int)
    func composerViewDidRequestSend(_ view: OpenChamberComposerView, text: String)
    func composerViewDidRequestAbort(_ view: OpenChamberComposerView)
    func composerViewDidRequestAttachPhotos(_ view: OpenChamberComposerView)
    func composerViewDidRequestAttachFiles(_ view: OpenChamberComposerView)
    func composerViewDidRequestModel(_ view: OpenChamberComposerView)
    func composerViewDidRequestCycleAgent(_ view: OpenChamberComposerView)
    func composerViewDidRequestOpenAgent(_ view: OpenChamberComposerView)
    func composerViewDidChangeExpanded(_ view: OpenChamberComposerView, expanded: Bool)
    func composerViewDidChangeHeight(_ view: OpenChamberComposerView)
    func composerViewDidRequestScrollToBottom(_ view: OpenChamberComposerView)
    func composerViewDidRequestRemoveAttachment(_ view: OpenChamberComposerView, id: String)
    func composerViewDidRequestAutocompleteAccept(_ view: OpenChamberComposerView, index: Int)
    func composerViewDidRequestAutocompleteDismiss(_ view: OpenChamberComposerView)
}

/// Floating iOS chat composer: collapsed glass pill, expanded glass card.
/// iOS 26 uses interactive `UIGlassEffect` when available; older systems use material blur.
final class OpenChamberComposerView: UIView, UITextViewDelegate {
    weak var delegate: OpenChamberComposerViewDelegate?

    private let collapsedPlus = OpenChamberComposerView.makeCircleButton(systemName: "plus")
    private let card = GlassBackdropView()
    private let attachmentStrip = UIScrollView()
    private let attachmentStack = UIStackView()
    private let textView = UITextView()
    private let placeholderLabel = UILabel()
    private let modelButton = UIButton(type: .custom)
    private let modelContent = UIStackView()
    private let modelIconView = UIImageView()
    private let modelNameLabel = UILabel()
    private let modelVariantLabel = UILabel()
    private let agentButton = UIButton(type: .custom)
    private let agentNameLabel = UILabel()
    private let agentCluster = UIStackView()
    private let footerSpacer = UIView()
    private let sendButton = OpenChamberComposerView.makeCircleButton(systemName: "arrow.up")
    private let queueSendButton = OpenChamberComposerView.makeCircleButton(systemName: "arrow.up")
    private let scrollChrome = GlassBackdropView()
    private let scrollButton = OpenChamberComposerView.makeCircleButton(systemName: "arrow.down")
    private let autocomplete = OpenChamberComposerAutocompleteView()
    private let expandedPlus = OpenChamberComposerView.makeCircleButton(systemName: "plus")
    private let footer = UIStackView()

    private var textHeightConstraint: NSLayoutConstraint?
    private var collapsedMinHeightConstraint: NSLayoutConstraint?
    private var expandedFooterConstraints: [NSLayoutConstraint] = []
    private var collapsedFooterConstraints: [NSLayoutConstraint] = []
    private var collapsedAgentConstraints: [NSLayoutConstraint] = []
    private var attachmentHeightConstraint: NSLayoutConstraint?
    private var scrollAboveCardConstraint: NSLayoutConstraint?
    private var scrollAboveQueueConstraint: NSLayoutConstraint?
    private var autocompleteHeightConstraint: NSLayoutConstraint?
    private var autocompleteState = ComposerAutocompleteState.closed
    private var lastAutocompleteClamp = AutocompleteClampStamp(height: -1, highlighted: -1, count: -1)

    private var attachmentItems: [AttachmentPreviewItem] = []
    private var citationRanges: [NSRange] = []
    private var isExpanded = false
    private var canSend = false
    private var canAbort = false
    private var attachmentCount = 0
    private var applyingExternalText = false
    private var appearanceIsDark = true
    private var agentLongPressFired = false
    private var placeholderText = "Tap to type"
    private var attachAria = "Attach files"
    private var attachPhotosLabel = "Photos"
    private var attachFilesLabel = "Files"
    private var sendAria = "Send message"
    private var queueAria = "Queue message"
    private var stopAria = "Stop generating"
    private var modelAria = "Select model"
    private var modelLabelText = ""
    private var modelVariantText = ""
    private var modelIconImage: UIImage?
    private var agentAria = "Select agent"
    private var agentLabelText = ""
    private var hasAppliedAgentLabel = false
    private var agentNameHideWorkItem: DispatchWorkItem?
    private var agentIdenticon: [Int] = []
    private var agentColor = UIColor.systemGreen
    private var showScrollToBottom = false
    private var scrollAria = ""

    var currentText: String { textView.text ?? "" }
    var isComposing: Bool { textView.markedTextRange != nil }
    var isExpandedState: Bool { isExpanded }
    /// System pickers resign first responder; keep the card expanded through that.
    private(set) var keepExpandedThroughPicker = false

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
        refreshAgentButton()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        clampAutocompleteHeight()
        delegate?.composerViewDidChangeHeight(self)
    }

    func applyState(
        text: String?,
        placeholder: String?,
        modelLabel: String?,
        modelVariantLabel: String?,
            canSend nextCanSend: Bool?,
            canAbort nextCanAbort: Bool?,
            attachmentCount nextAttachmentCount: Int?,
        appearance: String?,
        attachAria: String?,
        sendAria: String?,
        queueAria: String?,
        stopAria: String?,
        modelAria: String?,
        modelIcon: String?,
        agentAria: String?,
        agentLabel: String?,
        agentColor: String?,
        agentIdenticon: [Int]?,
        showScrollToBottom nextShowScroll: Bool?,
        scrollAria: String?,
        forceText: Bool,
        caret: Int?
    ) {
        if let placeholder { placeholderText = placeholder }
        if let attachAria { self.attachAria = attachAria }
        if let sendAria { self.sendAria = sendAria }
        if let queueAria { self.queueAria = queueAria }
        if let stopAria { self.stopAria = stopAria }
        if let modelAria { self.modelAria = modelAria }
        if let agentAria { self.agentAria = agentAria }
        collapsedPlus.accessibilityLabel = self.attachAria
        expandedPlus.accessibilityLabel = self.attachAria
        modelButton.accessibilityLabel = self.modelAria
        agentButton.accessibilityLabel = self.agentAria

        let attachmentCountChanged: Bool
        if let nextCanSend { canSend = nextCanSend }
        if let nextCanAbort { canAbort = nextCanAbort }
        if let nextAttachmentCount {
            attachmentCountChanged = nextAttachmentCount != attachmentCount
            attachmentCount = nextAttachmentCount
        } else {
            attachmentCountChanged = false
        }
        if let appearance {
            appearanceIsDark = appearance != "light"
            applyAppearance()
        }
        if let agentColor {
            self.agentColor = Self.parseColor(agentColor)
        }
        if let agentIdenticon {
            self.agentIdenticon = agentIdenticon
        }
        if let modelIcon {
            modelIconImage = Self.decodePng(modelIcon)
        }
        if let agentLabel {
            applyAgentLabel(agentLabel)
        }
        refreshAgentButton()
        if shouldApplyText(text, forceText: forceText) {
            applyingExternalText = true
            textView.text = text
            let length = (textView.text as NSString).length
            let location = caret.map { min(max(0, $0), length) } ?? length
            textView.selectedRange = NSRange(location: location, length: 0)
            applyingExternalText = false
            refreshPlaceholder()
            relayoutTextHeight()
            emitTextChange()
        }
        if let modelLabel {
            modelLabelText = modelLabel
        }
        if let modelVariantLabel {
            modelVariantText = modelVariantLabel
        }
        refreshModelButton()
        if attachmentCountChanged {
            refreshAttachmentStrip()
        }
        refreshSendButton()
        if let nextShowScroll {
            showScrollToBottom = nextShowScroll
        }
        if let scrollAria {
            self.scrollAria = scrollAria
        }
        refreshScrollButton()
        setNeedsLayout()
    }

    func applyAttachmentPreviews(_ items: [AttachmentPreviewItem]) {
        attachmentItems = items
        refreshAttachmentStrip()
        setNeedsLayout()
    }

    func applyCitationRanges(_ ranges: [NSRange]) {
        citationRanges = ranges
    }

    func applyAutocomplete(_ state: ComposerAutocompleteState) {
        autocompleteState = state
        refreshAutocomplete()
        setNeedsLayout()
    }

    private func shouldApplyText(_ incoming: String?, forceText: Bool) -> Bool {
        guard let incoming else { return false }
        if incoming == (textView.text ?? "") && !forceText { return false }
        if (textView.markedTextRange != nil || textView.isFirstResponder) && !forceText { return false }
        return true
    }

    func setAttachChooser(photos: String, files: String) {
        if !photos.isEmpty { attachPhotosLabel = photos }
        if !files.isEmpty { attachFilesLabel = files }
        refreshAttachMenu()
    }

    func setKeepExpandedThroughPicker(_ keep: Bool) {
        keepExpandedThroughPicker = keep
    }

    func setSuppressed(_ suppressed: Bool) {
        isHidden = suppressed
        if suppressed {
            textView.resignFirstResponder()
        }
        refreshScrollButton()
        delegate?.composerViewDidChangeHeight(self)
    }

    func containsTouch(at point: CGPoint, in host: UIView) -> Bool {
        if frame.contains(point) { return true }
        if !queueSendButton.isHidden,
           queueSendButton.convert(queueSendButton.bounds, to: host).contains(point) {
            return true
        }
        if !autocomplete.isHidden,
           autocomplete.convert(autocomplete.bounds, to: host).contains(point) {
            return true
        }
        guard !scrollChrome.isHidden else { return false }
        return scrollChrome.convert(scrollChrome.bounds, to: host).contains(point)
    }

    func restTop(in host: UIView) -> CGFloat {
        var top = convert(bounds, to: host).minY
        if !queueSendButton.isHidden {
            top = min(top, queueSendButton.convert(queueSendButton.bounds, to: host).minY)
        }
        // Scroll-to-bottom sits above Send and must not change published
        // occupancy — accessories fade instead of vacating this slot.
        return top
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if super.point(inside: point, with: event) { return true }
        if !queueSendButton.isHidden, queueSendButton.frame.contains(point) { return true }
        if !autocomplete.isHidden, autocomplete.frame.contains(point) { return true }
        guard !scrollChrome.isHidden else { return false }
        return scrollChrome.frame.contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if !queueSendButton.isHidden {
            let local = convert(point, to: queueSendButton)
            if queueSendButton.point(inside: local, with: event) {
                return queueSendButton.hitTest(local, with: event) ?? queueSendButton
            }
        }
        if !autocomplete.isHidden {
            let local = convert(point, to: autocomplete)
            if autocomplete.point(inside: local, with: event) {
                return autocomplete.hitTest(local, with: event) ?? autocomplete
            }
        }
        if !scrollChrome.isHidden {
            let local = convert(point, to: scrollChrome)
            if scrollChrome.point(inside: local, with: event) {
                return scrollChrome.hitTest(local, with: event) ?? scrollButton
            }
        }
        return super.hitTest(point, with: event)
    }

    func focusInput() {
        guard !isHidden else { return }
        textView.becomeFirstResponder()
    }

    func blurInput() {
        dismissAttachMenu()
        textView.resignFirstResponder()
    }

    func dismissAttachMenu() {
        collapsedPlus.contextMenuInteraction?.dismissMenu()
        expandedPlus.contextMenuInteraction?.dismissMenu()
    }

    func handleKeyboardDidHide() {
        dismissAttachMenu()
        if keepExpandedThroughPicker { return }
        if textView.isFirstResponder {
            textView.resignFirstResponder()
        }
        if isExpanded {
            setExpanded(false, animated: false)
        }
    }

    // MARK: - Build

    private func build() {
        refreshAttachMenu()
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        queueSendButton.addTarget(self, action: #selector(queueSendTapped), for: .touchUpInside)
        queueSendButton.isHidden = true
        scrollButton.addTarget(self, action: #selector(scrollTapped), for: .touchUpInside)
        scrollButton.isHidden = true
        scrollChrome.isHidden = true
        modelButton.addTarget(self, action: #selector(modelTapped), for: .touchUpInside)
        agentButton.addTarget(self, action: #selector(agentTapped), for: .touchUpInside)
        let agentLongPress = UILongPressGestureRecognizer(target: self, action: #selector(agentLongPressed(_:)))
        agentLongPress.minimumPressDuration = 0.5
        agentButton.addGestureRecognizer(agentLongPress)

        modelButton.translatesAutoresizingMaskIntoConstraints = false
        modelButton.backgroundColor = .clear
        modelButton.adjustsImageWhenHighlighted = false
        modelIconView.translatesAutoresizingMaskIntoConstraints = false
        modelIconView.contentMode = .scaleAspectFit
        modelIconView.setContentHuggingPriority(.required, for: .horizontal)
        modelNameLabel.font = .systemFont(ofSize: 11, weight: .medium)
        modelNameLabel.numberOfLines = 1
        modelNameLabel.lineBreakMode = .byTruncatingTail
        modelNameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        modelNameLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        modelVariantLabel.font = .systemFont(ofSize: 11, weight: .regular)
        modelVariantLabel.numberOfLines = 1
        modelVariantLabel.setContentHuggingPriority(.required, for: .horizontal)
        modelVariantLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        modelContent.axis = .horizontal
        modelContent.alignment = .center
        modelContent.spacing = 4
        modelContent.isUserInteractionEnabled = false
        modelContent.translatesAutoresizingMaskIntoConstraints = false
        modelContent.addArrangedSubview(modelIconView)
        modelContent.addArrangedSubview(modelNameLabel)
        modelContent.addArrangedSubview(modelVariantLabel)
        modelButton.addSubview(modelContent)

        agentButton.translatesAutoresizingMaskIntoConstraints = false
        agentButton.clipsToBounds = true
        agentButton.layer.cornerRadius = 4
        agentButton.imageView?.contentMode = .scaleAspectFit
        agentButton.adjustsImageWhenHighlighted = false
        agentButton.isAccessibilityElement = false

        agentNameLabel.translatesAutoresizingMaskIntoConstraints = false
        agentNameLabel.font = .systemFont(ofSize: 11, weight: .medium)
        agentNameLabel.numberOfLines = 1
        agentNameLabel.lineBreakMode = .byTruncatingTail
        agentNameLabel.isHidden = true
        agentNameLabel.alpha = 0
        agentNameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        agentCluster.axis = .horizontal
        agentCluster.alignment = .center
        agentCluster.spacing = 6
        agentCluster.translatesAutoresizingMaskIntoConstraints = false
        agentCluster.isUserInteractionEnabled = true
        agentCluster.isAccessibilityElement = true
        agentCluster.accessibilityTraits = .button
        agentCluster.setContentHuggingPriority(.required, for: .horizontal)
        agentCluster.addArrangedSubview(agentButton)
        agentCluster.addArrangedSubview(agentNameLabel)

        attachmentStrip.translatesAutoresizingMaskIntoConstraints = false
        attachmentStrip.showsHorizontalScrollIndicator = false
        attachmentStrip.alwaysBounceHorizontal = false
        attachmentStrip.clipsToBounds = false
        attachmentStrip.isHidden = true
        attachmentStack.axis = .horizontal
        attachmentStack.alignment = .center
        attachmentStack.spacing = 6
        attachmentStack.translatesAutoresizingMaskIntoConstraints = false
        attachmentStrip.addSubview(attachmentStack)

        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.delegate = self
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 4, bottom: 10, right: 4)
        textView.textContainer.lineFragmentPadding = 4
        textView.font = .systemFont(ofSize: 16)
        textView.adjustsFontForContentSizeCategory = true
        textView.isScrollEnabled = false
        textView.keyboardDismissMode = .interactive
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = true
        textView.tintColor = .label

        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        placeholderLabel.font = .systemFont(ofSize: 16)
        placeholderLabel.numberOfLines = 1

        footer.axis = .horizontal
        footer.alignment = .center
        footer.spacing = 6
        footer.translatesAutoresizingMaskIntoConstraints = false
        footerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        footerSpacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        modelButton.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        modelButton.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        footer.addArrangedSubview(expandedPlus)
        footer.addArrangedSubview(footerSpacer)
        footer.addArrangedSubview(agentCluster)
        footer.addArrangedSubview(modelButton)

        addSubview(card)
        addSubview(queueSendButton)
        addSubview(scrollChrome)
        addSubview(autocomplete)
        autocomplete.onAccept = { [weak self] index in
            guard let self else { return }
            self.delegate?.composerViewDidRequestAutocompleteAccept(self, index: index)
        }
        scrollChrome.contentView.addSubview(scrollButton)
        scrollChrome.setCornerRadius(18)
        card.contentView.addSubview(collapsedPlus)
        card.contentView.addSubview(attachmentStrip)
        card.contentView.addSubview(textView)
        card.contentView.addSubview(placeholderLabel)
        card.contentView.addSubview(footer)
        card.contentView.addSubview(sendButton)

        collapsedPlus.translatesAutoresizingMaskIntoConstraints = false
        expandedPlus.translatesAutoresizingMaskIntoConstraints = false
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        scrollButton.translatesAutoresizingMaskIntoConstraints = false

        let textHeight = textView.heightAnchor.constraint(equalToConstant: 40)
        textHeight.priority = .required
        textHeightConstraint = textHeight
        let attachmentHeight = attachmentStrip.heightAnchor.constraint(equalToConstant: 0)
        attachmentHeightConstraint = attachmentHeight
        let collapsedMinHeight = heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
        collapsedMinHeightConstraint = collapsedMinHeight

        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),

            collapsedPlus.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 10),
            collapsedPlus.widthAnchor.constraint(equalToConstant: 32),
            collapsedPlus.heightAnchor.constraint(equalToConstant: 32),

            sendButton.widthAnchor.constraint(equalToConstant: 32),
            sendButton.heightAnchor.constraint(equalToConstant: 32),
            sendButton.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -10),
            queueSendButton.widthAnchor.constraint(equalToConstant: 32),
            queueSendButton.heightAnchor.constraint(equalToConstant: 32),
            queueSendButton.centerXAnchor.constraint(equalTo: sendButton.centerXAnchor),
            queueSendButton.bottomAnchor.constraint(equalTo: sendButton.topAnchor, constant: -6),
            scrollChrome.widthAnchor.constraint(equalToConstant: 36),
            scrollChrome.heightAnchor.constraint(equalToConstant: 36),
            scrollChrome.centerXAnchor.constraint(equalTo: sendButton.centerXAnchor),
            modelIconView.widthAnchor.constraint(equalToConstant: 16),
            modelIconView.heightAnchor.constraint(equalToConstant: 16),
            modelContent.leadingAnchor.constraint(equalTo: modelButton.leadingAnchor, constant: 2),
            modelContent.trailingAnchor.constraint(equalTo: modelButton.trailingAnchor, constant: -2),
            modelContent.topAnchor.constraint(equalTo: modelButton.topAnchor),
            modelContent.bottomAnchor.constraint(equalTo: modelButton.bottomAnchor),
            scrollButton.centerXAnchor.constraint(equalTo: scrollChrome.contentView.centerXAnchor),
            scrollButton.centerYAnchor.constraint(equalTo: scrollChrome.contentView.centerYAnchor),
            scrollButton.widthAnchor.constraint(equalToConstant: 20),
            scrollButton.heightAnchor.constraint(equalToConstant: 20),

            agentButton.widthAnchor.constraint(equalToConstant: 16),
            agentButton.heightAnchor.constraint(equalToConstant: 16),
            agentNameLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 120),

            attachmentStrip.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 8),
            attachmentStrip.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 12),
            attachmentStrip.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -12),
            attachmentHeight,
            attachmentStack.topAnchor.constraint(equalTo: attachmentStrip.contentLayoutGuide.topAnchor),
            attachmentStack.bottomAnchor.constraint(equalTo: attachmentStrip.contentLayoutGuide.bottomAnchor),
            attachmentStack.leadingAnchor.constraint(equalTo: attachmentStrip.contentLayoutGuide.leadingAnchor),
            attachmentStack.trailingAnchor.constraint(equalTo: attachmentStrip.contentLayoutGuide.trailingAnchor),
            attachmentStack.heightAnchor.constraint(equalTo: attachmentStrip.frameLayoutGuide.heightAnchor),

            textHeight,

            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 8),
            placeholderLabel.trailingAnchor.constraint(equalTo: textView.trailingAnchor, constant: -8),
            placeholderLabel.centerYAnchor.constraint(equalTo: textView.centerYAnchor),

            expandedPlus.widthAnchor.constraint(equalToConstant: 32),
            expandedPlus.heightAnchor.constraint(equalToConstant: 32),
            modelButton.heightAnchor.constraint(equalToConstant: 26),
            modelButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 72),
            modelButton.widthAnchor.constraint(lessThanOrEqualToConstant: 220),
            modelNameLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
            collapsedMinHeight,
        ])

        scrollAboveCardConstraint = scrollChrome.bottomAnchor.constraint(equalTo: card.topAnchor, constant: -8)
        scrollAboveQueueConstraint = scrollChrome.bottomAnchor.constraint(equalTo: queueSendButton.topAnchor, constant: -8)
        scrollAboveCardConstraint?.isActive = true
        let autocompleteHeight = autocomplete.heightAnchor.constraint(equalToConstant: 0)
        autocompleteHeightConstraint = autocompleteHeight
        NSLayoutConstraint.activate([
            autocomplete.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            autocomplete.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            autocomplete.bottomAnchor.constraint(equalTo: card.topAnchor, constant: -8),
            autocompleteHeight,
        ])

        collapsedAgentConstraints = [
            agentCluster.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -10),
            agentCluster.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            agentCluster.heightAnchor.constraint(equalToConstant: 26),
        ]
        collapsedFooterConstraints = [
            collapsedPlus.centerYAnchor.constraint(equalTo: card.contentView.centerYAnchor),
            textView.leadingAnchor.constraint(equalTo: collapsedPlus.trailingAnchor, constant: 4),
            textView.centerYAnchor.constraint(equalTo: card.contentView.centerYAnchor),
            textView.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            sendButton.centerYAnchor.constraint(equalTo: card.contentView.centerYAnchor),
            footer.heightAnchor.constraint(equalToConstant: 0),
        ]
        expandedFooterConstraints = [
            collapsedPlus.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 12),
            textView.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 8),
            textView.topAnchor.constraint(equalTo: attachmentStrip.bottomAnchor, constant: 2),
            textView.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -8),
            footer.topAnchor.constraint(equalTo: textView.bottomAnchor, constant: 4),
            footer.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 10),
            footer.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            footer.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -18),
            sendButton.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -18),
        ]

        let tap = UITapGestureRecognizer(target: self, action: #selector(cardTapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        card.addGestureRecognizer(tap)
    }

    private func setExpanded(_ expanded: Bool, animated: Bool) {
        _ = animated
        let changed = isExpanded != expanded
        isExpanded = expanded
        // Keyboard-pin animation is in-flight when the field focuses. Any
        // constraint swap in that transaction slides the model/agent labels.
        UIView.performWithoutAnimation {
            self.collapsedPlus.isHidden = expanded
            self.expandedPlus.isHidden = !expanded
            self.modelButton.isHidden = !expanded
                || self.modelLabelText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            self.footer.isHidden = !expanded
            self.refreshAttachmentStrip()
            self.refreshSendButton()
            self.textView.textContainer.maximumNumberOfLines = expanded ? 0 : 1
            self.textView.isScrollEnabled = expanded
            self.card.setCornerRadius(expanded ? 22 : 26)
            self.collapsedFooterConstraints.forEach { $0.isActive = !expanded }
            self.expandedFooterConstraints.forEach { $0.isActive = expanded }
            self.refreshScrollButton()
            self.refreshAutocomplete()
            self.relayoutTextHeight()
            self.layoutIfNeeded()
        }
        delegate?.composerViewDidChangeHeight(self)
        if changed {
            delegate?.composerViewDidChangeExpanded(self, expanded: expanded)
        }
    }

    private func relayoutTextHeight() {
        let maxHeight: CGFloat = isExpanded ? 120 : 40
        let minHeight: CGFloat = isExpanded ? 44 : 40
        let width = max(textView.bounds.width, 160)
        let size = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        textHeightConstraint?.constant = min(max(size.height, minHeight), maxHeight)
        textView.isScrollEnabled = isExpanded && size.height > maxHeight
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    private func refreshPlaceholder() {
        placeholderLabel.text = placeholderText
        placeholderLabel.isHidden = !(textView.text ?? "").isEmpty
    }

    private func refreshAttachmentStrip() {
        let visible = isExpanded && !attachmentItems.isEmpty
        attachmentStrip.isHidden = !visible
        attachmentHeightConstraint?.constant = visible ? 40 : 0
        for view in attachmentStack.arrangedSubviews {
            attachmentStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard visible else { return }
        for item in attachmentItems {
            let cell = AttachmentPreviewCell(item: item, appearanceIsDark: appearanceIsDark)
            cell.onRemove = { [weak self] id in
                guard let self else { return }
                self.delegate?.composerViewDidRequestRemoveAttachment(self, id: id)
            }
            attachmentStack.addArrangedSubview(cell)
        }
    }

    private func refreshModelButton() {
        let trimmed = modelLabelText.trimmingCharacters(in: .whitespacesAndNewlines)
        let variant = modelVariantText.trimmingCharacters(in: .whitespacesAndNewlines)
        let titleColor = chromeColor().withAlphaComponent(0.8)
        let mutedColor = chromeColor().withAlphaComponent(0.45)
        UIView.performWithoutAnimation {
            modelIconView.image = Self.templateModelIcon(modelIconImage)
            modelIconView.tintColor = titleColor
            modelIconView.isHidden = modelIconView.image == nil
            modelNameLabel.text = trimmed
            modelNameLabel.textColor = titleColor
            modelVariantLabel.text = variant
            modelVariantLabel.textColor = mutedColor
            modelVariantLabel.isHidden = variant.isEmpty
            modelButton.backgroundColor = .clear
            modelButton.isHidden = !isExpanded || trimmed.isEmpty
            modelButton.accessibilityLabel = [trimmed, variant].filter { !$0.isEmpty }.joined(separator: " ")
            if modelButton.accessibilityLabel?.isEmpty ?? true {
                modelButton.accessibilityLabel = modelAria
            }
            modelButton.layoutIfNeeded()
        }
    }

    private var hasSendableText: Bool {
        !(textView.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func refreshSendButton() {
        let symbol = canAbort ? "stop.fill" : "arrow.up"
        let enabled = canAbort || canSend || hasSendableText
        sendButton.setImage(Self.symbol(symbol), for: .normal)
        sendButton.accessibilityLabel = canAbort ? stopAria : sendAria
        sendButton.isEnabled = enabled
        sendButton.backgroundColor = .clear
        sendButton.tintColor = chromeColor()
        sendButton.alpha = enabled ? 1 : 0.38

        let showQueueSend = isExpanded && canAbort && (canSend || hasSendableText)
        queueSendButton.isHidden = !showQueueSend
        queueSendButton.isEnabled = showQueueSend
        queueSendButton.backgroundColor = .clear
        queueSendButton.tintColor = chromeColor()
        queueSendButton.accessibilityLabel = queueAria.isEmpty ? sendAria : queueAria
        scrollAboveCardConstraint?.isActive = false
        scrollAboveQueueConstraint?.isActive = false
        if showQueueSend {
            scrollAboveQueueConstraint?.isActive = true
        } else {
            scrollAboveCardConstraint?.isActive = true
        }
    }

    private func refreshScrollButton() {
        let visible = showScrollToBottom && !isHidden && autocomplete.isHidden
        scrollChrome.isHidden = !visible
        scrollButton.isHidden = !visible
        scrollButton.accessibilityLabel = scrollAria
        scrollButton.backgroundColor = .clear
        scrollButton.tintColor = chromeColor()
        scrollChrome.appearanceIsDark = appearanceIsDark
        scrollChrome.refreshEffect()
    }

    private func refreshAutocomplete() {
        autocomplete.applyAppearance(isDark: appearanceIsDark)
        autocomplete.apply(autocompleteState, expanded: isExpanded)
        clampAutocompleteHeight()
        let visible = showScrollToBottom && !isHidden && autocomplete.isHidden
        scrollChrome.isHidden = !visible
        scrollButton.isHidden = !visible
    }

    private struct AutocompleteClampStamp: Equatable {
        let height: CGFloat
        let highlighted: Int
        let count: Int
    }

    private func clampAutocompleteHeight() {
        guard !autocomplete.isHidden else {
            autocompleteHeightConstraint?.constant = 0
            lastAutocompleteClamp = AutocompleteClampStamp(height: -1, highlighted: -1, count: -1)
            return
        }
        let space = window ?? superview
        let cardInSpace: CGRect
        let safeTop: CGFloat
        if let space {
            cardInSpace = card.convert(card.bounds, to: space)
            safeTop = space.safeAreaInsets.top
        } else {
            cardInSpace = card.frame
            safeTop = 0
        }
        // card.maxY is the keyboard-aware visible column (the card sits on
        // the keyboard). Full window height would keep the 40% cap too tall.
        let maxHeight = ComposerAutocompleteMetrics.maxHeight(
            popupBottom: cardInSpace.minY,
            boundaryTop: ComposerAutocompleteMetrics.headerFloor(safeAreaTop: safeTop),
            viewportHeight: max(cardInSpace.maxY, 0)
        )
        let next = min(autocomplete.contentHeight, maxHeight)
        if autocompleteHeightConstraint?.constant != next {
            autocompleteHeightConstraint?.constant = next
        }
        if next < ComposerAutocompleteMetrics.minPaintHeight {
            autocomplete.isHidden = true
            autocomplete.isUserInteractionEnabled = false
            lastAutocompleteClamp = AutocompleteClampStamp(height: -1, highlighted: -1, count: -1)
            let visible = showScrollToBottom && !isHidden
            scrollChrome.isHidden = !visible
            scrollButton.isHidden = !visible
            return
        }
        let stamp = AutocompleteClampStamp(
            height: next,
            highlighted: autocompleteState.highlightedIndex,
            count: autocompleteState.rows.count
        )
        guard stamp != lastAutocompleteClamp else { return }
        lastAutocompleteClamp = stamp
        DispatchQueue.main.async { [weak self] in
            self?.autocomplete.revealHighlightedRow()
        }
    }

    private func notifyText() {
        emitTextChange()
    }

    private func refreshAgentButton() {
        let image = Self.identiconImage(bits: agentIdenticon, color: agentColor, size: 16)
        agentButton.setImage(image, for: .normal)
        agentButton.isHidden = false
        agentCluster.accessibilityLabel = agentAria
        agentNameLabel.textColor = chromeColor().withAlphaComponent(0.8)
    }

    private func chromeColor() -> UIColor {
        appearanceIsDark ? UIColor.white : UIColor.black
    }

    private func applyAppearance() {
        overrideUserInterfaceStyle = appearanceIsDark ? .dark : .light
        let label = chromeColor()
        textView.textColor = label
        placeholderLabel.textColor = label.withAlphaComponent(0.45)
        refreshAttachmentStrip()
        card.appearanceIsDark = appearanceIsDark
        collapsedPlus.backgroundColor = .clear
        collapsedPlus.tintColor = label
        expandedPlus.backgroundColor = .clear
        expandedPlus.tintColor = label
        scrollChrome.appearanceIsDark = appearanceIsDark
        scrollButton.tintColor = label
        refreshModelButton()
        refreshSendButton()
        refreshScrollButton()
        refreshAutocomplete()
        refreshAgentButton()
        agentNameLabel.textColor = label.withAlphaComponent(0.8)
        card.refreshEffect()
    }

    private func applyAgentLabel(_ next: String) {
        let trimmed = next.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hasAppliedAgentLabel {
            hasAppliedAgentLabel = true
            agentLabelText = trimmed
            agentNameLabel.text = trimmed
            agentNameLabel.alpha = 0
            agentNameLabel.isHidden = true
            return
        }
        guard trimmed != agentLabelText else { return }
        agentLabelText = trimmed
        agentNameLabel.text = trimmed
        revealAgentNameBriefly()
    }

    private func revealAgentNameBriefly() {
        agentNameHideWorkItem?.cancel()
        guard !agentLabelText.isEmpty else {
            agentNameLabel.alpha = 0
            agentNameLabel.isHidden = true
            return
        }
        agentNameLabel.isHidden = false
        UIView.animate(withDuration: Self.agentLabelAnimSeconds) {
            self.agentNameLabel.alpha = 1
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            UIView.animate(withDuration: Self.agentLabelAnimSeconds) {
                self.agentNameLabel.alpha = 0
            } completion: { finished in
                if finished && self.agentNameLabel.alpha == 0 {
                    self.agentNameLabel.isHidden = true
                }
            }
        }
        agentNameHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.agentLabelHoldSeconds, execute: work)
    }

    private func refreshAttachMenu() {
        let photos = UIAction(
            title: attachPhotosLabel,
            image: UIImage(systemName: "photo.on.rectangle")
        ) { [weak self] _ in
            guard let self else { return }
            self.delegate?.composerViewDidRequestAttachPhotos(self)
        }
        let files = UIAction(
            title: attachFilesLabel,
            image: UIImage(systemName: "folder")
        ) { [weak self] _ in
            guard let self else { return }
            self.delegate?.composerViewDidRequestAttachFiles(self)
        }
        let menu = UIMenu(title: "", children: [photos, files])
        for button in [collapsedPlus, expandedPlus] {
            button.menu = menu
            button.showsMenuAsPrimaryAction = true
        }
    }

    @objc private func modelTapped() {
        textView.resignFirstResponder()
        delegate?.composerViewDidRequestModel(self)
    }

    @objc private func agentTapped() {
        if agentLongPressFired {
            agentLongPressFired = false
            return
        }
        delegate?.composerViewDidRequestCycleAgent(self)
    }

    @objc private func agentLongPressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        agentLongPressFired = true
        textView.resignFirstResponder()
        delegate?.composerViewDidRequestOpenAgent(self)
    }

    @objc private func scrollTapped() {
        delegate?.composerViewDidRequestScrollToBottom(self)
    }

    @objc private func sendTapped() {
        if canAbort {
            delegate?.composerViewDidRequestAbort(self)
            return
        }
        delegate?.composerViewDidRequestSend(self, text: currentText)
    }

    @objc private func queueSendTapped() {
        delegate?.composerViewDidRequestSend(self, text: currentText)
    }

    @objc private func cardTapped() {
        if !isExpanded {
            textView.becomeFirstResponder()
        }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        setExpanded(true, animated: false)
        notifyText()
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        if keepExpandedThroughPicker { return }
        setExpanded(false, animated: false)
    }

    func textViewDidChange(_ textView: UITextView) {
        refreshPlaceholder()
        relayoutTextHeight()
        refreshSendButton()
        delegate?.composerViewDidChangeHeight(self)
        guard !applyingExternalText else { return }
        emitTextChange()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !applyingExternalText else { return }
        emitTextChange()
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if text == "\n" {
            if textView.markedTextRange != nil { return true }
            if !autocomplete.isHidden {
                autocomplete.acceptHighlighted()
                return false
            }
            delegate?.composerViewDidRequestSend(self, text: textView.text ?? "")
            return false
        }
        if textView.markedTextRange != nil { return true }
        guard let expanded = expandedCitationEdit(range: range) else { return true }
        let ns = (textView.text ?? "") as NSString
        var deleteRange = expanded
        if text.isEmpty {
            let after = deleteRange.location + deleteRange.length
            if after < ns.length && ns.character(at: after) == 32 {
                deleteRange.length += 1
            } else if deleteRange.location > 0
                && after == ns.length
                && ns.character(at: deleteRange.location - 1) == 32 {
                deleteRange.location -= 1
                deleteRange.length += 1
            }
        }
        applyingExternalText = true
        textView.text = ns.replacingCharacters(in: deleteRange, with: text)
        let caret = min(deleteRange.location + (text as NSString).length, (textView.text as NSString?)?.length ?? 0)
        textView.selectedRange = NSRange(location: caret, length: 0)
        applyingExternalText = false
        refreshPlaceholder()
        relayoutTextHeight()
        refreshSendButton()
        delegate?.composerViewDidChangeHeight(self)
        emitTextChange()
        return false
    }

    private func emitTextChange() {
        let range = textView.selectedRange
        delegate?.composerViewDidChangeText(
            self,
            text: textView.text ?? "",
            selectionStart: range.location,
            selectionEnd: range.location + range.length
        )
    }

    private func expandedCitationEdit(range: NSRange) -> NSRange? {
        var hit: NSRange?
        for citation in citationRanges {
            guard citationTouches(citation, edit: range) else { continue }
            hit = hit.map { NSUnionRange($0, citation) } ?? citation
        }
        return hit.map { NSUnionRange($0, range) }
    }

    private func citationTouches(_ citation: NSRange, edit: NSRange) -> Bool {
        if NSIntersectionRange(citation, edit).length > 0 { return true }
        if edit.length == 0 {
            return edit.location > citation.location && edit.location < citation.location + citation.length
        }
        return false
    }

    private static let agentLabelHoldSeconds: TimeInterval = 1.0
    private static let agentLabelAnimSeconds: TimeInterval = 0.28

    static func decodePreviewImage(_ raw: String) -> UIImage? {
        decodePng(raw)
    }

    private static func decodePng(_ raw: String) -> UIImage? {
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let data = Data(base64Encoded: cleaned) else { return nil }
        return UIImage(data: data)
    }

    private static func templateModelIcon(_ image: UIImage?) -> UIImage? {
        guard let image else { return nil }
        let size = CGSize(width: 16, height: 16)
        let rendered = UIGraphicsImageRenderer(size: size).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return rendered.withRenderingMode(.alwaysTemplate)
    }

    private static func symbol(_ name: String) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
    }

    private static func makeCircleButton(systemName: String) -> UIButton {
        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setImage(symbol(systemName), for: .normal)
        button.backgroundColor = .clear
        button.tintColor = .label
        return button
    }

    private static func parseColor(_ raw: String) -> UIColor {
        let hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else {
            return .systemGreen
        }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    private static func identiconImage(bits: [Int], color: UIColor, size: CGFloat) -> UIImage {
        let grid = 5
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        return renderer.image { ctx in
            let cell = size / CGFloat(grid)
            color.withAlphaComponent(0.14).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
            color.setFill()
            for y in 0..<grid {
                for x in 0..<grid {
                    let index = y * grid + x
                    guard index < bits.count, bits[index] != 0 else { continue }
                    ctx.fill(CGRect(
                        x: CGFloat(x) * cell,
                        y: CGFloat(y) * cell,
                        width: cell,
                        height: cell
                    ))
                }
            }
        }
    }
}

extension OpenChamberComposerView: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if touch.view is UIControl { return false }
        var view = touch.view
        while let current = view {
            if current is AttachmentPreviewCell { return false }
            view = current.superview
        }
        return true
    }
}

struct AttachmentPreviewItem {
    let id: String
    let filename: String
    let mime: String
    let thumbnail: UIImage?
    let removeAria: String
}

private final class AttachmentPreviewCell: UIView {
    var onRemove: ((String) -> Void)?

    init(item: AttachmentPreviewItem, appearanceIsDark: Bool) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let isImage = item.mime.hasPrefix("image/") && item.thumbnail != nil
        let remove = UIButton(type: .system)
        remove.translatesAutoresizingMaskIntoConstraints = false
        remove.setImage(
            UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 8, weight: .bold)),
            for: .normal
        )
        remove.tintColor = appearanceIsDark ? .white : .black
        remove.backgroundColor = (appearanceIsDark ? UIColor.black : UIColor.white).withAlphaComponent(0.45)
        remove.layer.cornerRadius = 8
        remove.accessibilityLabel = item.removeAria.isEmpty ? item.filename : item.removeAria
        remove.addAction(UIAction { [weak self] _ in
            self?.onRemove?(item.id)
        }, for: .touchUpInside)

        if isImage {
            let imageView = UIImageView(image: item.thumbnail)
            imageView.translatesAutoresizingMaskIntoConstraints = false
            imageView.contentMode = .scaleAspectFill
            imageView.clipsToBounds = true
            imageView.layer.cornerRadius = 8
            imageView.layer.cornerCurve = .continuous
            imageView.layer.borderWidth = 0.5
            imageView.layer.borderColor = (appearanceIsDark
                ? UIColor.white.withAlphaComponent(0.2)
                : UIColor.black.withAlphaComponent(0.12)).cgColor
            addSubview(imageView)
            addSubview(remove)
            NSLayoutConstraint.activate([
                widthAnchor.constraint(equalToConstant: 40),
                heightAnchor.constraint(equalToConstant: 40),
                imageView.topAnchor.constraint(equalTo: topAnchor),
                imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
                imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
                imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
                remove.widthAnchor.constraint(equalToConstant: 16),
                remove.heightAnchor.constraint(equalToConstant: 16),
                remove.topAnchor.constraint(equalTo: topAnchor, constant: 2),
                remove.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            ])
            return
        }

        let icon = UIImageView(image: UIImage(systemName: "doc"))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = appearanceIsDark ? UIColor.white.withAlphaComponent(0.8) : UIColor.black.withAlphaComponent(0.7)
        icon.contentMode = .scaleAspectFit
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = item.filename
        label.font = .systemFont(ofSize: 11, weight: .medium)
        label.textColor = appearanceIsDark ? UIColor.white.withAlphaComponent(0.85) : UIColor.black.withAlphaComponent(0.8)
        label.lineBreakMode = .byTruncatingMiddle
        layer.cornerRadius = 8
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = (appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.16)
            : UIColor.black.withAlphaComponent(0.12)).cgColor
        addSubview(icon)
        addSubview(label)
        addSubview(remove)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 40),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 84),
            widthAnchor.constraint(lessThanOrEqualToConstant: 148),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 14),
            icon.heightAnchor.constraint(equalToConstant: 14),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 4),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: remove.leadingAnchor, constant: -4),
            remove.widthAnchor.constraint(equalToConstant: 16),
            remove.heightAnchor.constraint(equalToConstant: 16),
            remove.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            remove.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
}

final class GlassBackdropView: UIView {
    var appearanceIsDark = true { didSet { refreshEffect() } }

    private let blurView = UIVisualEffectView(effect: nil)
    // Interactive UIGlassEffect samples touches through its own contentView.
    // Keeping chrome as a sibling of the effect view blocked the hover highlight
    // and the slight press magnification.
    var contentView: UIView { blurView.contentView }

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        layer.cornerCurve = .continuous
        clipsToBounds = false
        blurView.translatesAutoresizingMaskIntoConstraints = false
        blurView.layer.cornerCurve = .continuous
        blurView.clipsToBounds = true
        addSubview(blurView)
        NSLayoutConstraint.activate([
            blurView.topAnchor.constraint(equalTo: topAnchor),
            blurView.bottomAnchor.constraint(equalTo: bottomAnchor),
            blurView.leadingAnchor.constraint(equalTo: leadingAnchor),
            blurView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        setCornerRadius(26)
        refreshEffect()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setCornerRadius(_ radius: CGFloat) {
        layer.cornerRadius = radius
        blurView.layer.cornerRadius = radius
        refreshHoverStyle()
    }

    func refreshEffect() {
        let style: UIUserInterfaceStyle = appearanceIsDark ? .dark : .light
        overrideUserInterfaceStyle = style
        blurView.overrideUserInterfaceStyle = style
        if let glass = Self.makeGlassEffect() {
            blurView.effect = glass
            backgroundColor = .clear
            layer.borderWidth = 0
            blurView.layer.borderWidth = 0
            refreshHoverStyle()
            return
        }
        let material: UIBlurEffect.Style = appearanceIsDark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight
        blurView.effect = UIBlurEffect(style: material)
        backgroundColor = .clear
        blurView.backgroundColor = appearanceIsDark
            ? UIColor.black.withAlphaComponent(0.18)
            : UIColor.white.withAlphaComponent(0.22)
        blurView.layer.borderWidth = 0.5
        blurView.layer.borderColor = (appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.16)
            : UIColor.white.withAlphaComponent(0.55)).cgColor
        refreshHoverStyle()
    }

    private func refreshHoverStyle() {
        guard #available(iOS 17.0, *) else { return }
        let shape = UIShape.rect(cornerRadius: layer.cornerRadius, cornerCurve: .continuous)
        hoverStyle = UIHoverStyle(effect: .lift, shape: shape)
        blurView.hoverStyle = UIHoverStyle(effect: .highlight, shape: shape)
    }

    private static func makeGlassEffect() -> UIVisualEffect? {
        if #available(iOS 26.0, *) {
            let glass = UIGlassEffect(style: .regular)
            glass.isInteractive = true
            return glass
        }
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
