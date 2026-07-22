import Intents
import ImageIO
import UIKit
import UniformTypeIdentifiers

class ShareViewController: UIViewController, UITextViewDelegate {
    private typealias CollectedItem = (URL, String, String)

    private enum Strings {
        static let title = localized("share.title", "Share with OpenChamber")
        static let cancel = localized("share.cancel", "Cancel")
        static let send = localized("share.send", "Send")
        static let sending = localized("share.sending", "Sending…")
        static let preparing = localized("share.preparing", "Preparing shared content…")
        static let message = localized("share.message", "Message")
        static let messagePlaceholder = localized("share.message.placeholder", "Add a message")
        static let destination = localized("share.destination", "Assistant")
        static let missingTarget = localized("share.missingTarget", "Choose a default share assistant in OpenChamber.")
        static let oneImage = localized("share.images.single", "1 image")
        static let imageCount = localized("share.images.multiple", "%d images")
        static let assistantAvatar = localized("share.avatar.accessibility", "%@ avatar")
        static let imagePreview = localized("share.imagePreview.accessibility", "Shared image %d of %d")

        private static func localized(_ key: String, _ value: String) -> String {
            NSLocalizedString(key, tableName: nil, bundle: .main, value: value, comment: "")
        }
    }

    private var target: [String: Any]?
    private var collectedItems: [CollectedItem] = []
    private var isPreparing = true
    private var isSending = false
    private var didFinish = false

    private var contentText: String { textView.text }

    private let contentStack = UIStackView()
    private let editor = UIView()
    private let textView = UITextView()
    private let placeholderLabel = UILabel()
    private let previewSection = UIStackView()
    private let previewStack = UIStackView()
    private let statusLabel = UILabel()
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let statusRow = UIStackView()
    private let cancelButton = UIButton(type: .system)
    private let sendButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        if let conversationID = (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier {
            target = OpenChamberShareStore.target(conversationIdentifier: conversationID)
        } else {
            target = OpenChamberShareStore.target()
        }
        configureView()
        configureTarget()
        collect { [weak self] result in
            guard let self, !self.didFinish else {
                if case .success(let content) = result { ShareViewController.removeTemporaryFiles(content.items) }
                return
            }
            self.isPreparing = false
            self.activityIndicator.stopAnimating()
            switch result {
            case .success(let content):
                self.collectedItems = content.items
                self.textView.text = content.text
                self.statusRow.isHidden = self.target != nil
                self.updatePreview()
                self.updateControls()
            case .failure(let error):
                self.didFinish = true
                self.extensionContext?.cancelRequest(withError: error)
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let fittingWidth = max(view.bounds.width - 32, 280)
        let fittingHeight = contentStack.systemLayoutSizeFitting(
            CGSize(width: fittingWidth, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height
        preferredContentSize = CGSize(width: view.bounds.width, height: min(max(fittingHeight + 32, 330), 560))
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        editor.layer.borderColor = UIColor.separator.cgColor
    }

    deinit {
        if !didFinish { Self.removeTemporaryFiles(collectedItems) }
    }

    private func configureView() {
        view.backgroundColor = .systemGroupedBackground

        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.keyboardDismissMode = .interactive
        scrollView.alwaysBounceVertical = false
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        let titleLabel = label(text: Strings.title, style: .headline, color: .label)
        titleLabel.textAlignment = .center
        contentStack.addArrangedSubview(titleLabel)
        contentStack.addArrangedSubview(makeDestinationCard())

        let messageLabel = label(text: Strings.message, style: .subheadline, color: .secondaryLabel)
        contentStack.addArrangedSubview(messageLabel)

        editor.backgroundColor = .secondarySystemGroupedBackground
        editor.layer.cornerRadius = 14
        editor.layer.cornerCurve = .continuous
        editor.layer.borderWidth = 1 / UIScreen.main.scale
        editor.layer.borderColor = UIColor.separator.cgColor
        editor.translatesAutoresizingMaskIntoConstraints = false

        textView.delegate = self
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.tintColor = .tintColor
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
        textView.accessibilityLabel = Strings.message
        textView.translatesAutoresizingMaskIntoConstraints = false
        editor.addSubview(textView)

        placeholderLabel.text = Strings.messagePlaceholder
        placeholderLabel.font = .preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        editor.addSubview(placeholderLabel)

        NSLayoutConstraint.activate([
            editor.heightAnchor.constraint(greaterThanOrEqualToConstant: 104),
            textView.leadingAnchor.constraint(equalTo: editor.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: editor.trailingAnchor),
            textView.topAnchor.constraint(equalTo: editor.topAnchor),
            textView.bottomAnchor.constraint(equalTo: editor.bottomAnchor),
            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 15),
            placeholderLabel.topAnchor.constraint(equalTo: textView.topAnchor, constant: 12),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor, constant: -15),
        ])
        contentStack.addArrangedSubview(editor)

        previewSection.axis = .vertical
        previewSection.spacing = 9
        previewSection.isHidden = true
        contentStack.addArrangedSubview(previewSection)

        statusRow.addArrangedSubview(activityIndicator)
        statusRow.addArrangedSubview(statusLabel)
        statusRow.axis = .horizontal
        statusRow.alignment = .center
        statusRow.spacing = 8
        statusRow.isAccessibilityElement = true
        statusRow.accessibilityLabel = Strings.preparing
        statusLabel.text = Strings.preparing
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel
        activityIndicator.startAnimating()
        contentStack.addArrangedSubview(statusRow)

        let actions = UIStackView(arrangedSubviews: [cancelButton, sendButton])
        actions.axis = .horizontal
        actions.distribution = .fillEqually
        actions.spacing = 12
        configureButtons()
        contentStack.addArrangedSubview(actions)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -16),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),
        ])
    }

    private func makeDestinationCard() -> UIView {
        let card = UIView()
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 16
        card.layer.cornerCurve = .continuous
        card.translatesAutoresizingMaskIntoConstraints = false

        let avatar = UIImageView(image: Self.avatarImage(seed: target?["avatarSeed"] as? String ?? target?["assistantID"] as? String ?? "OpenChamber"))
        avatar.layer.cornerRadius = 22
        avatar.clipsToBounds = true
        avatar.isAccessibilityElement = true
        avatar.accessibilityLabel = String(format: Strings.assistantAvatar, target?["name"] as? String ?? Strings.destination)
        avatar.translatesAutoresizingMaskIntoConstraints = false

        let name = label(text: target?["name"] as? String ?? Strings.destination, style: .headline, color: .label)
        name.numberOfLines = 2
        let server = label(text: target?["serverLabel"] as? String ?? Strings.missingTarget, style: .subheadline, color: .secondaryLabel)
        server.numberOfLines = 2
        let labels = UIStackView(arrangedSubviews: [name, server])
        labels.axis = .vertical
        labels.spacing = 2

        let symbol = UIImageView(image: UIImage(systemName: "arrow.up.circle.fill"))
        symbol.tintColor = .tintColor
        symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title2)
        symbol.setContentHuggingPriority(.required, for: .horizontal)
        symbol.isAccessibilityElement = false

        let row = UIStackView(arrangedSubviews: [avatar, labels, symbol])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)

        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 44),
            avatar.heightAnchor.constraint(equalTo: avatar.widthAnchor),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
        ])
        return card
    }

    private func configureButtons() {
        var cancelConfiguration = UIButton.Configuration.gray()
        cancelConfiguration.title = Strings.cancel
        cancelConfiguration.cornerStyle = .large
        cancelButton.configuration = cancelConfiguration
        cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        var sendConfiguration = UIButton.Configuration.filled()
        sendConfiguration.title = Strings.send
        sendConfiguration.image = UIImage(systemName: "paperplane.fill")
        sendConfiguration.imagePadding = 7
        sendConfiguration.cornerStyle = .large
        sendButton.configuration = sendConfiguration
        sendButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)

        cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        sendButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        updateControls()
    }

    private func configureTarget() {
        guard target == nil else { return }
        statusLabel.text = Strings.missingTarget
        statusRow.accessibilityLabel = Strings.missingTarget
        statusLabel.textColor = .secondaryLabel
    }

    private func updatePreview() {
        previewStack.arrangedSubviews.forEach { view in
            previewStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard !collectedItems.isEmpty else {
            previewSection.isHidden = true
            return
        }

        let countText = collectedItems.count == 1 ? Strings.oneImage : String.localizedStringWithFormat(Strings.imageCount, collectedItems.count)
        let countLabel = label(text: countText, style: .subheadline, color: .secondaryLabel)
        previewSection.addArrangedSubview(countLabel)

        previewStack.axis = .horizontal
        previewStack.spacing = 8
        for (index, item) in collectedItems.enumerated() {
            let thumbnail = UIImageView(image: Self.thumbnailImage(at: item.0) ?? UIImage(systemName: "photo"))
            thumbnail.contentMode = .scaleAspectFill
            thumbnail.backgroundColor = .tertiarySystemGroupedBackground
            thumbnail.tintColor = .secondaryLabel
            thumbnail.layer.cornerRadius = 10
            thumbnail.layer.cornerCurve = .continuous
            thumbnail.clipsToBounds = true
            thumbnail.isAccessibilityElement = true
            thumbnail.accessibilityLabel = String(format: Strings.imagePreview, index + 1, collectedItems.count)
            thumbnail.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                thumbnail.widthAnchor.constraint(equalToConstant: 64),
                thumbnail.heightAnchor.constraint(equalTo: thumbnail.widthAnchor),
            ])
            previewStack.addArrangedSubview(thumbnail)
        }

        let previewScroll = UIScrollView()
        previewScroll.showsHorizontalScrollIndicator = false
        previewScroll.translatesAutoresizingMaskIntoConstraints = false
        previewStack.translatesAutoresizingMaskIntoConstraints = false
        previewScroll.addSubview(previewStack)
        NSLayoutConstraint.activate([
            previewScroll.heightAnchor.constraint(equalToConstant: 64),
            previewStack.leadingAnchor.constraint(equalTo: previewScroll.contentLayoutGuide.leadingAnchor),
            previewStack.trailingAnchor.constraint(equalTo: previewScroll.contentLayoutGuide.trailingAnchor),
            previewStack.topAnchor.constraint(equalTo: previewScroll.contentLayoutGuide.topAnchor),
            previewStack.bottomAnchor.constraint(equalTo: previewScroll.contentLayoutGuide.bottomAnchor),
            previewStack.heightAnchor.constraint(equalTo: previewScroll.frameLayoutGuide.heightAnchor),
        ])
        previewSection.addArrangedSubview(previewScroll)
        previewSection.isHidden = false
    }

    private func updateControls() {
        placeholderLabel.isHidden = !textView.text.isEmpty
        let hasText = !textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        sendButton.isEnabled = target != nil && !isPreparing && !isSending && (hasText || !collectedItems.isEmpty)
        cancelButton.isEnabled = !isSending
    }

    func textViewDidChange(_ textView: UITextView) {
        updateControls()
    }

    @objc private func cancel() {
        didFinish = true
        Self.removeTemporaryFiles(collectedItems)
        collectedItems = []
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    @objc private func send() {
        guard let target, sendButton.isEnabled else { return }
        isSending = true
        updateControls()
        textView.isEditable = false
        var configuration = sendButton.configuration
        configuration?.title = Strings.sending
        configuration?.showsActivityIndicator = true
        configuration?.image = nil
        sendButton.configuration = configuration

        let items = collectedItems
        let text = textView.text
        collectedItems = []
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let envelope = try OpenChamberShareStore.write(target: target, text: text, items: items)
                Self.removeTemporaryFiles(items)
                DispatchQueue.main.async {
                    self.didFinish = true
                    OpenChamberShareStore.donateAssistantInteraction(target: target) { _ in
                        DispatchQueue.main.async {
                            guard let url = URL(string: "openchamber://share/\(envelope.operationID)") else {
                                self.extensionContext?.completeRequest(returningItems: nil)
                                return
                            }
                            self.extensionContext?.open(url) { _ in self.extensionContext?.completeRequest(returningItems: nil) }
                        }
                    }
                }
            } catch {
                Self.removeTemporaryFiles(items)
                DispatchQueue.main.async {
                    self.didFinish = true
                    self.extensionContext?.cancelRequest(withError: error)
                }
            }
        }
    }

    private func collect(completion: @escaping (Result<(text: String, items: [CollectedItem]), Error>) -> Void) {
        let extensionItems = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let attributedText = extensionItems.compactMap { $0.attributedContentText?.string }
        let providers = extensionItems.compactMap(\.attachments).flatMap { $0 }
        let imageProviders = providers.enumerated().filter { $0.element.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard imageProviders.count <= OpenChamberShareStore.maximumImages else {
            completion(.failure(ShareError.tooManyImages))
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var files: [(Int, CollectedItem)] = []
        var providerText: [Int: String] = [:]
        var failure: Error?

        for (index, provider) in providers.enumerated() {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) { continue }
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                    defer { group.leave() }
                    let text = Self.text(from: item)
                    guard let text, !text.isEmpty else { return }
                    lock.lock()
                    providerText[index] = text
                    lock.unlock()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                    defer { group.leave() }
                    let text = Self.text(from: item)
                    guard let text, !text.isEmpty else { return }
                    lock.lock()
                    providerText[index] = text
                    lock.unlock()
                }
            }
        }

        for (index, provider) in imageProviders {
            let typeIdentifier = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true } ?? UTType.image.identifier
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                defer { group.leave() }
                guard let url else {
                    lock.lock()
                    if failure == nil { failure = ShareError.imageUnavailable }
                    lock.unlock()
                    return
                }
                let type = UTType(typeIdentifier)
                let suggestedExtension = URL(fileURLWithPath: provider.suggestedName ?? "").pathExtension
                let fileExtension = Self.safeExtension(url.pathExtension.isEmpty ? (suggestedExtension.isEmpty ? Self.safeExtension(type) : suggestedExtension) : url.pathExtension)
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
                do {
                    try FileManager.default.copyItem(at: url, to: temporary)
                    guard let mime = Self.imageMIME(for: temporary) else {
                        try? FileManager.default.removeItem(at: temporary)
                        lock.lock()
                        if failure == nil { failure = ShareError.unrecognizedImage }
                        lock.unlock()
                        return
                    }
                    lock.lock()
                    files.append((index, (temporary, provider.suggestedName ?? "shared-image.\(fileExtension)", mime)))
                    lock.unlock()
                } catch {
                    try? FileManager.default.removeItem(at: temporary)
                    lock.lock()
                    if failure == nil { failure = ShareError.imageUnavailable }
                    lock.unlock()
                }
            }
        }

        group.notify(queue: .main) {
            lock.lock()
            let collected = files.sorted { $0.0 < $1.0 }.map(\.1)
            let loadedText = providerText.sorted { $0.key < $1.key }.map(\.value)
            let collectedFailure = failure
            lock.unlock()
            if let collectedFailure {
                Self.removeTemporaryFiles(collected)
                completion(.failure(collectedFailure))
                return
            }

            var seen = Set<String>()
            let text = ([self.contentText] + attributedText + loadedText)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }
                .joined(separator: "\n")
            completion(.success((text, collected)))
        }
    }

    private static func text(from item: NSSecureCoding?) -> String? {
        if let value = item as? URL { return value.absoluteString }
        if let value = item as? NSURL { return value.absoluteString }
        if let value = item as? String { return value }
        if let value = item as? NSAttributedString { return value.string }
        if let value = item as? Data { return String(data: value, encoding: .utf8) }
        return nil
    }

    private func label(text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        return label
    }

    private static func avatarImage(seed: String) -> UIImage {
        let colors: [UIColor] = [.systemPurple, .systemTeal, .systemBlue, .systemOrange, .systemCyan, .systemYellow, .systemPink]
        var hash: Int32 = 0
        for codeUnit in seed.utf16 { hash = hash &* 31 &+ Int32(codeUnit) }
        let magnitude = hash < 0 ? UInt64(-Int64(hash)) : UInt64(hash)
        let color = colors[Int(magnitude % UInt64(colors.count))]
        let size = CGSize(width: 88, height: 88)
        let cell = size.width / 5
        return UIGraphicsImageRenderer(size: size).image { context in
            context.cgContext.setFillColor(UIColor.secondarySystemGroupedBackground.cgColor)
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            context.cgContext.setFillColor(color.withAlphaComponent(0.16).cgColor)
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            context.cgContext.setFillColor(color.cgColor)
            var bits = UInt32(bitPattern: hash)
            for y in 0..<5 {
                for x in 0..<3 {
                    let enabled = (bits & 1) == 1
                    bits >>= 1
                    guard enabled else { continue }
                    for mirroredX in Set([x, 4 - x]) {
                        context.cgContext.fill(CGRect(x: CGFloat(mirroredX) * cell, y: CGFloat(y) * cell, width: cell, height: cell))
                    }
                }
            }
        }
    }

    private static func thumbnailImage(at url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 160,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private static func safeExtension(_ value: String) -> String {
        let sanitized = String(value.filter { $0.isLetter || $0.isNumber }).lowercased()
        return sanitized.isEmpty ? "img" : sanitized
    }

    private static func safeExtension(_ type: UTType?) -> String {
        let ext = type?.preferredFilenameExtension ?? "img"
        return safeExtension(ext)
    }

    private static func imageMIME(for file: URL) -> String? {
        guard let input = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? input.close() }
        guard let data = try? input.read(upToCount: 64) else { return nil }
        switch file.pathExtension.lowercased() {
        case "jpg", "jpeg":
            return data.starts(with: Data([0xff, 0xd8, 0xff])) ? "image/jpeg" : nil
        case "png":
            return data.starts(with: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png" : nil
        case "gif":
            return data.starts(with: Data("GIF87a".utf8)) || data.starts(with: Data("GIF89a".utf8)) ? "image/gif" : nil
        case "webp":
            return data.starts(with: Data("RIFF".utf8)) && data.count >= 12 && data.subdata(in: 8..<12) == Data("WEBP".utf8) ? "image/webp" : nil
        case "heic", "heif":
            return hasHEICSignature(data) ? "image/heic" : nil
        default:
            return nil
        }
    }

    private static func hasHEICSignature(_ data: Data) -> Bool {
        guard data.count >= 16, data.subdata(in: 4..<8) == Data("ftyp".utf8) else { return false }
        let boxSize = data.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        let end = min(data.count, boxSize)
        guard end >= 16 else { return false }
        let brands = Set(["heic", "heix", "hevc", "hevx"])
        return stride(from: 8, to: end - 3, by: 4).contains { offset in
            guard let brand = String(data: data.subdata(in: offset..<(offset + 4)), encoding: .ascii) else { return false }
            return brands.contains(brand)
        }
    }

    private static func removeTemporaryFiles(_ files: [CollectedItem]) {
        for file in files { try? FileManager.default.removeItem(at: file.0) }
    }
}
