import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
}

type Msg = {
  role: "user" | "assistant"
  text: string
  html: string
  idx: number // linear index in page
}

export type LinearNode = {
  id: string // stable per linear index: lin_0, lin_1...
  userText: string
  userHtml: string
  assistantText: string
  assistantHtml: string
  summary: string // user first 20 chars
  linearIndex: number
}

function cleanText(s: string) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+\n/g, "\n").trim()
}

function makeSummaryFromUserText(userText: string, max = 20) {
  const t = (userText || "").replace(/\s+/g, " ").trim()
  if (!t) return "(empty)"
  if (t.length <= max) return t
  return t.slice(0, max) + "…"
}

function getChatIdFromUrl(url: string) {
  // chatgpt.com/c/<id>...
  const m = url.match(/\/c\/([a-zA-Z0-9-]+)/)
  return m?.[1] ?? "unknown"
}

function uniqueTopLevelRoleEls(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>("[data-message-author-role]"))

  const top = all.filter((el) => {
    const parentRole = el.parentElement?.closest("[data-message-author-role]")
    return parentRole == null
  })

  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  for (const el of top) {
    if (!seen.has(el)) {
      seen.add(el)
      out.push(el)
    }
  }
  return out
}

function extractMessagesByRole(): { messages: Msg[]; debug: any } {
  const main = document.querySelector("main") as HTMLElement | null
  const root = main ?? (document.body as HTMLElement)

  const roleEls = uniqueTopLevelRoleEls(root)

  const messagesRaw: Msg[] = []
  let idx = 0
  for (const el of roleEls) {
    const roleRaw = el.getAttribute("data-message-author-role")
    const role =
      roleRaw === "user" ? "user" : roleRaw === "assistant" ? "assistant" : null
    if (!role) continue

    const text = cleanText(el.innerText)
    const html = (el.innerHTML || "").trim()

    // 有些 role 容器里可能包含空壳/按钮，text 为空就跳过
    if (!text && !html) continue

    messagesRaw.push({ role, text, html, idx })
    idx += 1
  }

  // 合并连续同角色（避免 assistant 被拆成多段）
  const merged: Msg[] = []
  for (const m of messagesRaw) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) {
      last.text = cleanText(last.text + "\n\n" + m.text)
      last.html = (last.html || "") + "\n" + (m.html || "")
    } else {
      merged.push({ ...m })
    }
  }

  return {
    messages: merged,
    debug: {
      used: "data-message-author-role",
      roleCount: roleEls.length,
      messageCount: merged.length
    }
  }
}

function pairToLinearNodes(messages: Msg[]): LinearNode[] {
  const nodes: LinearNode[] = []
  let pendingUser: Msg | null = null
  let linearIndex = 0

  for (const m of messages) {
    if (m.role === "user") {
      pendingUser = m
      continue
    }

    // assistant
    if (pendingUser) {
      const userText = pendingUser.text || ""
      const assistantText = m.text || ""

      nodes.push({
        id: `lin_${linearIndex}`,
        userText,
        userHtml: pendingUser.html || "",
        assistantText,
        assistantHtml: m.html || "",
        summary: makeSummaryFromUserText(userText, 20),
        linearIndex
      })

      linearIndex += 1
      pendingUser = null
    }
  }

  return nodes
}

console.log("[TreeChatExt] content script loaded:", location.href)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_PAGE_INFO") {
    const { messages, debug } = extractMessagesByRole()
    const linearNodes = pairToLinearNodes(messages)
    const url = location.href

    sendResponse({
      title: document.title,
      url,
      chatId: getChatIdFromUrl(url),
      linearNodes,
      debug: {
        ...debug,
        nodeCount: linearNodes.length
      }
    })
  }
})
