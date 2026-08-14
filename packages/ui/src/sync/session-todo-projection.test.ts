import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Part, Todo } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "./types"
import type { DirectoryStore } from "./child-store"
import {
  projectTodosFromTranscript,
  seedSessionTodosFromTranscript,
} from "./session-todo-projection"

function createDirectoryStore(initial: Partial<State> = {}): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    todo: initial.todo ?? {},
    patch: (partial: Partial<State>) => set(partial),
    replace: (next: State) => set(next),
  }))
}

function toolPart(input: {
  id: string
  tool: string
  status?: string
  todos?: unknown
  output?: unknown
}): Part {
  return {
    id: input.id,
    type: "tool",
    tool: input.tool,
    sessionID: "ses_a",
    messageID: "msg_1",
    state: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.todos !== undefined ? { input: { todos: input.todos } } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
    },
  } as unknown as Part
}

const FIRST: Todo & { id: string } = {
  id: "t1",
  content: "测试 todowrite 工具基本调用",
  status: "in_progress",
  priority: "high",
}
const SECOND: Todo & { id: string } = {
  id: "t2",
  content: "验证任务状态更新 (completed)",
  status: "pending",
  priority: "medium",
}
const THIRD: Todo & { id: string } = {
  id: "t3",
  content: "验证多任务并行展示",
  status: "pending",
  priority: "low",
}

describe("projectTodosFromTranscript", () => {
  test("returns the newest completed todowrite list", () => {
    const todos = projectTodosFromTranscript({
      messageOrder: ["msg_old", "msg_new"],
      partsByMessageID: {
        msg_old: [toolPart({
          id: "p_old",
          tool: "todowrite",
          status: "completed",
          todos: [{ content: "old", status: "pending", priority: "low" }],
        })],
        msg_new: [toolPart({
          id: "p_new",
          tool: "todowrite",
          status: "completed",
          todos: [FIRST, SECOND, THIRD],
        })],
      },
    })

    expect(todos).toEqual([FIRST, SECOND, THIRD])
  })

  test("prefers a later part on the same message", () => {
    const todos = projectTodosFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [
          toolPart({
            id: "p1",
            tool: "todowrite",
            status: "completed",
            todos: [{ content: "first write", status: "pending", priority: "medium" }],
          }),
          toolPart({
            id: "p2",
            tool: "todowrite",
            status: "completed",
            todos: [FIRST, SECOND],
          }),
        ],
      },
    })

    expect(todos).toEqual([FIRST, SECOND])
  })

  test("skips failed todowrite parts and uses the previous completed list", () => {
    const todos = projectTodosFromTranscript({
      messageOrder: ["msg_1", "msg_2"],
      partsByMessageID: {
        msg_1: [toolPart({
          id: "p_ok",
          tool: "todowrite",
          status: "completed",
          todos: [FIRST],
        })],
        msg_2: [toolPart({
          id: "p_fail",
          tool: "todowrite",
          status: "error",
          todos: [SECOND],
        })],
      },
    })

    expect(todos).toEqual([FIRST])
  })

  test("reads todos from tool output when input is missing", () => {
    const todos = projectTodosFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [toolPart({
          id: "p_read",
          tool: "todoread",
          status: "completed",
          output: [FIRST, SECOND],
        })],
      },
    })

    expect(todos).toEqual([FIRST, SECOND])
  })

  test("parses JSON string output", () => {
    const todos = projectTodosFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [toolPart({
          id: "p_json",
          tool: "todowrite",
          status: "completed",
          output: JSON.stringify({ todos: [THIRD] }),
        })],
      },
    })

    expect(todos).toEqual([THIRD])
  })

  test("returns an empty list when the loaded tail has no todo tools", () => {
    expect(projectTodosFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [toolPart({
          id: "p_bash",
          tool: "bash",
          status: "completed",
          todos: [FIRST],
        })],
      },
    })).toEqual([])
  })
})

describe("seedSessionTodosFromTranscript", () => {
  test("fills an unoccupied session todo slot and persists it", () => {
    const store = createDirectoryStore()
    const persisted: Array<{ sessionID: string; todos: Todo[] }> = []

    const seeded = seedSessionTodosFromTranscript({
      sessionID: "ses_a",
      store,
      transcript: {
        messageOrder: ["msg_1"],
        partsByMessageID: {
          msg_1: [toolPart({
            id: "p1",
            tool: "todowrite",
            status: "completed",
            todos: [FIRST, SECOND, THIRD],
          })],
        },
      },
      persist: (sessionID, todos) => {
        persisted.push({ sessionID, todos })
      },
    })

    expect(seeded).toBe(true)
    expect(store.getState().todo.ses_a).toEqual([FIRST, SECOND, THIRD])
    expect(persisted).toEqual([{ sessionID: "ses_a", todos: [FIRST, SECOND, THIRD] }])
  })

  test("does not overwrite a live todo.updated list", () => {
    const live = [{ content: "from sse", status: "in_progress", priority: "high" }]
    const store = createDirectoryStore({ todo: { ses_a: live } })
    const persisted: Todo[][] = []

    const seeded = seedSessionTodosFromTranscript({
      sessionID: "ses_a",
      store,
      transcript: {
        messageOrder: ["msg_1"],
        partsByMessageID: {
          msg_1: [toolPart({
            id: "p1",
            tool: "todowrite",
            status: "completed",
            todos: [FIRST],
          })],
        },
      },
      persist: (_sessionID, todos) => {
        persisted.push(todos)
      },
    })

    expect(seeded).toBe(false)
    expect(store.getState().todo.ses_a).toBe(live)
    expect(persisted).toEqual([])
  })

  test("does not resurrect todos over an explicit empty live list", () => {
    const store = createDirectoryStore({ todo: { ses_a: [] } })

    const seeded = seedSessionTodosFromTranscript({
      sessionID: "ses_a",
      store,
      transcript: {
        messageOrder: ["msg_1"],
        partsByMessageID: {
          msg_1: [toolPart({
            id: "p1",
            tool: "todowrite",
            status: "completed",
            todos: [FIRST],
          })],
        },
      },
    })

    expect(seeded).toBe(false)
    expect(store.getState().todo.ses_a).toEqual([])
  })

  test("does not write when the transcript has no usable todos", () => {
    const store = createDirectoryStore()
    const persisted: Todo[][] = []

    const seeded = seedSessionTodosFromTranscript({
      sessionID: "ses_a",
      store,
      transcript: {
        messageOrder: ["msg_1"],
        partsByMessageID: { msg_1: [] },
      },
      persist: (_sessionID, todos) => {
        persisted.push(todos)
      },
    })

    expect(seeded).toBe(false)
    expect(store.getState().todo.ses_a).toBeUndefined()
    expect(persisted).toEqual([])
  })

  test("skips seeding when the hydrate became stale", () => {
    const store = createDirectoryStore()

    const seeded = seedSessionTodosFromTranscript({
      sessionID: "ses_a",
      store,
      transcript: {
        messageOrder: ["msg_1"],
        partsByMessageID: {
          msg_1: [toolPart({
            id: "p1",
            tool: "todowrite",
            status: "completed",
            todos: [FIRST],
          })],
        },
      },
      isStale: () => true,
    })

    expect(seeded).toBe(false)
    expect(store.getState().todo.ses_a).toBeUndefined()
  })
})
