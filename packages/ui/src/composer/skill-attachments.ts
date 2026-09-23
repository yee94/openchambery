/** Preserve canonical chip text for history; V2 loads skills from attachments. */
export function skillAttachmentsFromText(text: string): Array<{ id: string; name: string }> {
    return Array.from(new Set(
        Array.from(text.matchAll(/\[skill:([A-Za-z0-9][A-Za-z0-9_-]*)\]/g), (match) => match[1]),
    ), (id) => ({ id, name: id }));
}
