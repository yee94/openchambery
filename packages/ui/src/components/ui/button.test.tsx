import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { Button } from "./button"

describe("Button", () => {
  test("mode chips stay borderless and neutral while exposing selection", () => {
    for (const pressed of [false, true]) {
      const element = Button({ variant: "chip", "aria-pressed": pressed, children: "Mode" })
      expect(element.props["aria-pressed"]).toBe(pressed)
      expect(element.props.className).toContain("border-0")
      expect(element.props.className).toContain("text-foreground")
      expect(element.props.className).toContain("aria-pressed:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--surface-muted))]")
      expect(element.props.className).not.toMatch(/primary|accent/)
    }
  })

  test("ordinary action variants share the borderless solid default", () => {
    const primary = Button({ children: "Save" }).props.className
    expect(primary).toContain("border-0")
    for (const variant of ["outline", "neutral"] as const) {
      expect(Button({ variant, children: "Add" }).props.className).toBe(primary)
    }
  })

  test("primary actions keep neutral solid styling across sizes and states", () => {
    for (const size of ["default", "sm", "xs", "lg", "icon", "mobileIcon"] as const) {
      for (const props of [{}, { disabled: true }, { "aria-busy": true }, { asChild: true }]) {
        const element = Button({ size, ...props, children: "Save" })
        expect(element.props.className).toContain("bg-[var(--surface-muted)]")
        expect(element.props.className).toContain("text-foreground")
        expect(element.props.className).toContain("focus-visible:ring-foreground/20")
        expect(element.props.className).not.toMatch(/primary|accent/)
      }
    }
  })

  test("primary consumers do not restore accent overrides or raw accent-filled actions", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "..")
    const violations: string[] = []
    const accent = /(?:bg|text|border|ring|shadow)-primary|--primary-(?:base|foreground|hover|active)/
    const visitDirectory = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) { visitDirectory(file); continue }
        if (!file.endsWith(".tsx") || file.includes(".test.")) continue
        const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const visit = (node: ts.Node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText(source)
            const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
            const variant = attributes.find((attribute) => attribute.name.getText(source) === "variant")
            const primary = tag === "Button" && (!variant || variant.initializer?.getText(source) === '"default"')
            for (const attribute of attributes) {
              if (!["className", "style"].includes(attribute.name.getText(source))) continue
              const value = attribute.initializer
              if (!value) continue
              const rawAccentFill = tag === "button" && ts.isStringLiteral(value) && /bg-primary|bg-\[var\(--primary-base\)/.test(value.text)
              if ((primary && accent.test(value.getText(source))) || rawAccentFill) {
                violations.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
              }
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    visitDirectory(root)
    expect(violations).toEqual([])
  })

  test("defaults native buttons to type button", () => {
    const element = Button({ children: "Cancel" })

    expect(element.props.type).toBe("button")
  })

  test("preserves explicit native button types", () => {
    const element = Button({ children: "Save", type: "submit" })

    expect(element.props.type).toBe("submit")
  })

  test("does not default asChild buttons", () => {
    const element = Button({ asChild: true, children: "Link" })

    expect(element.props.type).toBe(undefined)
  })
})
