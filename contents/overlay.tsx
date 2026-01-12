// contents/overlay.tsx
import React, { useEffect, useMemo, useRef, useState } from "react"
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
}

/* ================= Light DOM mount (不使用 Shadow DOM) ================= */

const HOST_ID = "treechat-overlay-host"

export const getRootContainer = async () => {
  let host = document.getElementById(HOST_ID) as HTMLDivElement | null
  if (!host) {
    host = document.createElement("div")
    host.id = HOST_ID
    document.documentElement.appendChild(host)
  }
  return host
}

/* ================= Types ================= */

type Msg = {
  role: "user" | "assistant"
  text: string
  html: string
}

type Pair = {
  userText: string
  assistantText: string
  userHtml: string
  assistantHtml: string
}

type TreeNode = {
  id: string
  parentId: string
  children: string[]
  depth: number
  linearIndex: number
  summary: string
  userHtml: string
  assistantHtml: string
}

type TreeState = {
  convoKey: string
  seenLinearCount: number
  activeId: string
  nodes: Record<string, TreeNode>
  collapsedIds: Record<string, boolean> // ✅ 右侧结构折叠状态
}

const ROOT_ID = "root"

/* ================= ✅ Persist ================= */

const STORAGE_PREFIX = "treechat:v3:"
const STORAGE_SCROLL_PREFIX = "treechat:scroll:v1:"

function storageKey(convoKey: string) {
  return `${STORAGE_PREFIX}${convoKey}`
}

function storageScrollKey(convoKey: string) {
  return `${STORAGE_SCROLL_PREFIX}${convoKey}`
}

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function loadTree(convoKey: string): TreeState | null {
  const st = safeJsonParse<TreeState>(localStorage.getItem(storageKey(convoKey)))
  if (!st) return null
  if (!st.collapsedIds) (st as any).collapsedIds = {}
  return st
}

function stripTreeForPersist(st: TreeState): TreeState {
  const nodes: Record<string, TreeNode> = {}
  for (const [id, n] of Object.entries(st.nodes)) {
    nodes[id] = {
      id: n.id,
      parentId: n.parentId,
      children: n.children,
      depth: n.depth,
      linearIndex: n.linearIndex,
      summary: n.summary,
      userHtml: "",
      assistantHtml: ""
    }
  }
  return {
    convoKey: st.convoKey,
    seenLinearCount: st.seenLinearCount,
    activeId: st.activeId,
    nodes,
    collapsedIds: st.collapsedIds ?? {}
  }
}

function saveTree(st: TreeState) {
  try {
    localStorage.setItem(storageKey(st.convoKey), JSON.stringify(st))
  } catch {
    // ignore
  }
}

type ScrollPersist = {
  leftTop: number
  rightTop: number
  rightLeft: number
}

function loadScroll(convoKey: string): ScrollPersist | null {
  return safeJsonParse<ScrollPersist>(localStorage.getItem(storageScrollKey(convoKey)))
}

function saveScroll(convoKey: string, s: ScrollPersist) {
  try {
    localStorage.setItem(storageScrollKey(convoKey), JSON.stringify(s))
  } catch {
    // ignore
  }
}

/* ================= Utils ================= */

function cleanText(s: string) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+\n/g, "\n").trim()
}

function makeSummaryFromUserText(userText: string, max = 20) {
  const t = (userText || "").replace(/\s+/g, " ").trim()
  if (!t) return "(empty)"
  return t.length <= max ? t : t.slice(0, max) + "…"
}

function getConversationKey() {
  const m = location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/)
  return m ? `c_${m[1]}` : location.pathname
}

/* ================= DOM extract ================= */

function uniqueTopLevelRoleEls(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>("[data-message-author-role]"))
  return all.filter((el) => el.parentElement?.closest("[data-message-author-role]") == null)
}

function extractMessages(): Msg[] {
  const main = document.querySelector("main") as HTMLElement | null
  const root = main ?? document.body
  const els = uniqueTopLevelRoleEls(root)

  const out: Msg[] = []
  for (const el of els) {
    const roleRaw = el.getAttribute("data-message-author-role")
    const role = roleRaw === "user" ? "user" : roleRaw === "assistant" ? "assistant" : null
    if (!role) continue

    const text = cleanText(el.innerText)
    const html = (el.innerHTML || "").trim()
    if (!text && !html) continue

    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.text = cleanText(last.text + "\n\n" + text)
      last.html = (last.html || "") + "\n" + (html || "")
    } else {
      out.push({ role, text, html })
    }
  }
  return out
}

function pairMessages(msgs: Msg[]): Pair[] {
  const out: Pair[] = []
  let pending: Msg | null = null

  for (const m of msgs) {
    if (m.role === "user") {
      pending = m
      continue
    }
    if (pending) {
      out.push({
        userText: pending.text,
        assistantText: m.text,
        userHtml: pending.html,
        assistantHtml: m.html
      })
      pending = null
    }
  }
  return out
}

/* ================= Tree logic ================= */

function freshTree(key: string): TreeState {
  return {
    convoKey: key,
    seenLinearCount: 0,
    activeId: ROOT_ID,
    collapsedIds: {},
    nodes: {
      [ROOT_ID]: {
        id: ROOT_ID,
        parentId: ROOT_ID,
        children: [],
        depth: 0,
        linearIndex: -1,
        summary: "Root",
        userHtml: "",
        assistantHtml: ""
      }
    }
  }
}

function appendUnderActive(st: TreeState, pair: Pair, idx: number): TreeState {
  const parent = st.nodes[st.activeId] ?? st.nodes[ROOT_ID]
  const id = `n_${idx}_${Math.random().toString(16).slice(2)}`

  const node: TreeNode = {
    id,
    parentId: parent.id,
    children: [],
    depth: parent.depth + 1,
    linearIndex: idx,
    summary: makeSummaryFromUserText(pair.userText, 20),
    userHtml: pair.userHtml,
    assistantHtml: pair.assistantHtml
  }

  return {
    ...st,
    activeId: id,
    seenLinearCount: idx + 1,
    nodes: {
      ...st.nodes,
      [id]: node,
      [parent.id]: { ...parent, children: [...parent.children, id] }
    }
  }
}

function pathToRoot(st: TreeState): TreeNode[] {
  const out: TreeNode[] = []
  let curId = st.activeId
  const guard = new Set<string>()

  while (curId && curId !== ROOT_ID && !guard.has(curId)) {
    guard.add(curId)
    const cur = st.nodes[curId]
    if (!cur) break
    out.push(cur)
    curId = cur.parentId
  }
  return out.reverse()
}

function flattenTree(st: TreeState): TreeNode[] {
  const res: TreeNode[] = []
  const dfs = (id: string) => {
    const n = st.nodes[id]
    if (!n) return
    if (id !== ROOT_ID) res.push(n)
    for (const c of n.children) dfs(c)
  }
  dfs(ROOT_ID)
  return res
}

/* ================= ✅ Align helper ================= */

function buildAlignedLinearTreeFromPairs(convoKey: string, pairs: Pair[]): TreeState {
  const nodes: Record<string, TreeNode> = {
    [ROOT_ID]: {
      id: ROOT_ID,
      parentId: ROOT_ID,
      children: [],
      depth: 0,
      linearIndex: -1,
      summary: "Root",
      userHtml: "",
      assistantHtml: ""
    }
  }

  let parentId = ROOT_ID
  for (let i = 0; i < pairs.length; i++) {
    const id = `n_align_${i}` // ✅ deterministic
    const parent = nodes[parentId]
    nodes[id] = {
      id,
      parentId,
      children: [],
      depth: (parent?.depth ?? 0) + 1,
      linearIndex: i,
      summary: makeSummaryFromUserText(pairs[i]?.userText ?? "", 20),
      userHtml: "",
      assistantHtml: ""
    }
    nodes[parentId] = { ...nodes[parentId], children: [...nodes[parentId].children, id] }
    parentId = id
  }

  const activeId = pairs.length > 0 ? `n_align_${pairs.length - 1}` : ROOT_ID

  return {
    convoKey,
    seenLinearCount: pairs.length,
    activeId,
    nodes,
    collapsedIds: {}
  }
}

/* ================= Collapse helpers ================= */

function hasChildren(st: TreeState, id: string): boolean {
  const n = st.nodes[id]
  return !!(n && n.children && n.children.length > 0)
}

function isHiddenByCollapsed(st: TreeState, nodeId: string): boolean {
  let curId = nodeId
  const guard = new Set<string>()
  while (curId && curId !== ROOT_ID && !guard.has(curId)) {
    guard.add(curId)
    const cur = st.nodes[curId]
    if (!cur) break
    const pId = cur.parentId
    if (pId && st.collapsedIds?.[pId]) return true
    curId = pId
  }
  return false
}

/* ================= ✅ Delete helpers ================= */

function collectSubtreeIds(st: TreeState, rootId: string): string[] {
  const res: string[] = []
  const dfs = (id: string) => {
    const n = st.nodes[id]
    if (!n) return
    res.push(id)
    for (const c of n.children || []) dfs(c)
  }
  dfs(rootId)
  return res
}

function deleteSubtree(st: TreeState, targetId: string): TreeState {
  if (!st.nodes[targetId]) return st
  if (targetId === ROOT_ID) return st // 不允许删 root

  const target = st.nodes[targetId]
  const parentId = target.parentId
  const parent = st.nodes[parentId]

  const toDelete = new Set(collectSubtreeIds(st, targetId))

  // 1) nodes: 删除子树节点
  const nextNodes: Record<string, TreeNode> = { ...st.nodes }
  for (const id of toDelete) delete nextNodes[id]

  // 2) 父节点 children: 移除 targetId
  if (parent && nextNodes[parentId]) {
    nextNodes[parentId] = {
      ...parent,
      children: (parent.children || []).filter((c) => c !== targetId)
    }
  }

  // 3) collapsedIds: 清理被删节点的折叠状态
  const nextCollapsed: Record<string, boolean> = { ...(st.collapsedIds ?? {}) }
  for (const id of Object.keys(nextCollapsed)) {
    if (toDelete.has(id)) delete nextCollapsed[id]
  }

  // 4) activeId: 切到 parent（如果 parent 不存在就回 root）
  const nextActiveId = nextNodes[parentId] ? parentId : ROOT_ID

  // ✅ seenLinearCount 不回退：避免 refresh 重新补回旧节点
  return {
    ...st,
    activeId: nextActiveId,
    nodes: nextNodes,
    collapsedIds: nextCollapsed
  }
}

/* ================= ErrorBoundary ================= */

class SafeBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err: any) {
    console.error("[TreeChat] render error:", this.props.label ?? "", err)
  }
  render() {
    if (this.state.hasError) {
      return <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>(render error)</pre>
    }
    return this.props.children
  }
}

/* ================= Overlay ================= */

const INDENT_PX = 18

export default function Overlay() {
  const convoKeyNow = getConversationKey()

  // ✅ collapse 不卸载 overlay，只是隐藏
  const [collapsed, setCollapsed] = useState(true)

  const [tree, setTree] = useState<TreeState>(() => {
    const saved = loadTree(convoKeyNow)
    return saved ?? freshTree(convoKeyNow)
  })

  const treeRef = useRef(tree)
  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  /* ================= ✅ Theme sync (follow ChatGPT appearance) ================= */

  type TcTheme = "light" | "dark"

  const detectTcTheme = (): TcTheme => {
    const html = document.documentElement as HTMLElement

    if (html.classList.contains("dark")) return "dark"
    if (html.classList.contains("light")) return "light"

    const dt = (html.getAttribute("data-theme") || "").toLowerCase()
    if (dt === "dark" || dt === "light") return dt as TcTheme

    const dcm = (html.getAttribute("data-color-mode") || "").toLowerCase()
    if (dcm === "dark" || dcm === "light") return dcm as TcTheme

    const bg = getComputedStyle(document.body).backgroundColor
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
    if (m) {
      const r = Number(m[1]),
        g = Number(m[2]),
        b = Number(m[3])
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      return lum < 128 ? "dark" : "light"
    }

    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }

  const [tcTheme, setTcTheme] = useState<TcTheme>(() => detectTcTheme())

  useEffect(() => {
    const apply = () => setTcTheme(detectTcTheme())
    apply()

    const obs = new MutationObserver(() => apply())
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-mode"]
    })

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    const onMq = () => apply()
    try {
      mq?.addEventListener("change", onMq)
    } catch {
      // @ts-ignore
      mq?.addListener?.(onMq)
    }

    return () => {
      obs.disconnect()
      try {
        mq?.removeEventListener("change", onMq)
      } catch {
        // @ts-ignore
        mq?.removeListener?.(onMq)
      }
    }
  }, [])

  /* ---------- persist structure ---------- */

  const saveTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTree(stripTreeForPersist(tree))
    }, 180)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [tree])

  /* ---------- render helpers ---------- */

  const forceRenderChatGPT = () => {
    const main = document.querySelector("main") as HTMLElement | null
    if (!main) return
    const prevTop = main.scrollTop
    main.scrollTop = main.scrollHeight
    requestAnimationFrame(() => {
      main.scrollTop = prevTop
    })
  }

  const locateInChatGPTAndCollapse = async (idx: number) => {
    const TOP_OFFSET = 64

    const getScrollParent = (el: HTMLElement | null): HTMLElement | null => {
      let cur = el?.parentElement ?? null
      while (cur) {
        const st = window.getComputedStyle(cur)
        const oy = st.overflowY
        const canScroll =
          (oy === "auto" || oy === "scroll" || oy === "overlay") &&
          cur.scrollHeight > cur.clientHeight + 2
        if (canScroll) return cur
        cur = cur.parentElement
      }
      return null
    }

    const getUserEls = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'))

    const main = document.querySelector("main") as HTMLElement | null

    // 先尝试直接获取 target
    let target = getUserEls()[idx] || null

    // 如果找不到，滚动到底部加载更多内容
    if (!target && main) {
      const prevTop = main.scrollTop
      main.scrollTop = main.scrollHeight
      await new Promise((r) => setTimeout(r, 140))
      target = getUserEls()[idx] || null
      // 恢复滚动位置（如果还是找不到）
      if (!target) {
        main.scrollTop = prevTop
        return
      }
    }

    if (!target) return

    target.scrollIntoView({ block: "start", behavior: "auto" })

    const scroller =
      getScrollParent(target) || (main && main.scrollHeight > main.clientHeight + 2 ? main : null)

    const clampScrollTop = (el: HTMLElement, v: number) => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      return Math.min(max, Math.max(0, v))
    }

    const alignOnce = () => {
      if (!scroller) {
        const y = target.getBoundingClientRect().top + window.scrollY - TOP_OFFSET
        window.scrollTo({ top: y, behavior: "auto" })
        return
      }

      const scRect = scroller.getBoundingClientRect()
      const tRect = target.getBoundingClientRect()
      const delta = tRect.top - scRect.top - TOP_OFFSET
      scroller.scrollTop = clampScrollTop(scroller, scroller.scrollTop + delta)
    }

    const isAligned = () => {
      const tTop = target.getBoundingClientRect().top
      return Math.abs(tTop - TOP_OFFSET) <= 10
    }

    alignOnce()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    alignOnce()
    await new Promise((r) => setTimeout(r, 50))
    if (!isAligned()) {
      alignOnce()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      if (!isAligned()) alignOnce()
    }

    setCollapsed(true)
  }

  const [livePairsTick, setLivePairsTick] = useState(0)
  const livePairs = useMemo(() => {
    return pairMessages(extractMessages())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePairsTick, tree.activeId])

  const getLiveHtmlByIndex = (idx: number) => {
    const p = livePairs[idx]
    if (!p) return { userHtml: "(not loaded yet)", assistantHtml: "(not loaded yet)" }
    return { userHtml: p.userHtml, assistantHtml: p.assistantHtml }
  }

  /* ---------- refresh logic ---------- */

  const retryRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)

  const refresh = () => {
    const st = treeRef.current

    const key = getConversationKey()
    if (st.convoKey !== key) {
      const saved = loadTree(key)
      const next = saved ?? freshTree(key)
      setTree(next)
      treeRef.current = next

      retryRef.current = 0
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }

      setLivePairsTick((x) => x + 1)
      return
    }

    forceRenderChatGPT()
    setLivePairsTick((x) => x + 1)

    const pairs = pairMessages(extractMessages())
    if (pairs.length <= st.seenLinearCount) {
      if (retryRef.current < 2) {
        retryRef.current += 1
        if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          requestAnimationFrame(() => {
            forceRenderChatGPT()
            setLivePairsTick((x) => x + 1)

            const pairs2 = pairMessages(extractMessages())
            if (pairs2.length > treeRef.current.seenLinearCount) {
              let next = treeRef.current
              for (let i = next.seenLinearCount; i < pairs2.length; i++) {
                next = appendUnderActive(next, pairs2[i], i)
              }
              setTree(next)
              retryRef.current = 0
            }
          })
        }, 90)
      }
      return
    }

    retryRef.current = 0
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    let next = st
    for (let i = st.seenLinearCount; i < pairs.length; i++) {
      next = appendUnderActive(next, pairs[i], i)
    }
    setTree(next)
  }

  /* ================= ✅ Align button logic ================= */

  const [aligning, setAligning] = useState(false)

  const alignToDom = async () => {
    if (aligning) return

    const ok = window.confirm(
      "Confirm align?\n\nThis will re-read the current chat and rearrange all nodes into a linear structure."
    )
    if (!ok) return

    setAligning(true)

    try {
      const main = document.querySelector("main") as HTMLElement | null
      if (main) {
        const prevTop = main.scrollTop
        const steps = 10
        for (let i = 0; i <= steps; i++) {
          main.scrollTop = (i / steps) * main.scrollHeight
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 70))
        }
        main.scrollTop = prevTop
      }

      forceRenderChatGPT()
      setLivePairsTick((x) => x + 1)

      const key = getConversationKey()
      const pairs = pairMessages(extractMessages())

      const next = buildAlignedLinearTreeFromPairs(key, pairs)

      setTree(next)
      treeRef.current = next

      saveTree(stripTreeForPersist(next))
    } finally {
      setAligning(false)
    }
  }

  /* ================= ✅ Delete button logic ================= */

  const deleteActiveNode = () => {
    const st = treeRef.current
    const id = st.activeId

    if (!id || id === ROOT_ID) {
      window.alert("Cannot delete Root.")
      return
    }

    const ok = window.confirm(
      "Confirm delete?\n\nThis will delete the selected node and all its descendants."
    )
    if (!ok) return

    const next = deleteSubtree(st, id)
    setTree(next)
    treeRef.current = next
    saveTree(stripTreeForPersist(next))
    setLivePairsTick((x) => x + 1)
  }

  // 首次 + DOM 变化 + URL 变化
  useEffect(() => {
    refresh()

    const main = document.querySelector("main") ?? document.body
    const obs = new MutationObserver(() => {
      refresh()
    })
    obs.observe(main, { childList: true, subtree: true, characterData: true })

    let lastUrl = location.href
    const t = window.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        retryRef.current = 0
        refresh()
      }
    }, 700)

    return () => {
      obs.disconnect()
      window.clearInterval(t)
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => {
      forceRenderChatGPT()
      refresh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.activeId])

  /* ---------- UI state helpers ---------- */

  const pathNodes = useMemo(() => pathToRoot(tree), [tree])

  // ✅ NEW: 当前 active branch（root → ... → active）上的 id set
  const activePathIds = useMemo(() => {
    const ids = new Set<string>()
    ids.add(ROOT_ID)
    for (const n of pathNodes) ids.add(n.id)
    ids.add(tree.activeId)
    return ids
  }, [tree.activeId, pathNodes])

  const flatNodes = useMemo(() => {
    const all = flattenTree(tree)
    return all.filter((n) => !isHiddenByCollapsed(tree, n.id))
  }, [tree])

  /* ================= ✅ 关键：保持滚动位置（不再“极端跳”） ================= */

  const leftRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)

  const cardTopRefMap = useRef<Record<string, HTMLDivElement | null>>({})

  const didRestoreScrollRef = useRef<string>("")

  useEffect(() => {
    const key = tree.convoKey
    if (didRestoreScrollRef.current === key) return
    didRestoreScrollRef.current = key

    const s = loadScroll(key)

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const left = leftRef.current
        const right = rightRef.current

        if (s) {
          if (left) left.scrollTop = s.leftTop ?? left.scrollTop
          if (right) {
            right.scrollTop = s.rightTop ?? right.scrollTop
            right.scrollLeft = s.rightLeft ?? right.scrollLeft
          }
          return
        }

        if (left) left.scrollTop = left.scrollHeight
        if (right) {
          right.scrollTop = right.scrollHeight
          right.scrollLeft = right.scrollWidth
        }
      })
    })
  }, [tree.convoKey])

  const scrollSaveTimerRef = useRef<number | null>(null)

  const scheduleSaveScroll = () => {
    if (scrollSaveTimerRef.current) window.clearTimeout(scrollSaveTimerRef.current)
    scrollSaveTimerRef.current = window.setTimeout(() => {
      const left = leftRef.current
      const right = rightRef.current
      if (!left || !right) return
      saveScroll(treeRef.current.convoKey, {
        leftTop: left.scrollTop,
        rightTop: right.scrollTop,
        rightLeft: right.scrollLeft
      })
    }, 120)
  }

  useEffect(() => {
    const left = leftRef.current
    const right = rightRef.current
    if (!left || !right) return

    const onLeft = () => scheduleSaveScroll()
    const onRight = () => scheduleSaveScroll()

    left.addEventListener("scroll", onLeft, { passive: true })
    right.addEventListener("scroll", onRight, { passive: true })

    return () => {
      left.removeEventListener("scroll", onLeft)
      right.removeEventListener("scroll", onRight)
      if (scrollSaveTimerRef.current) {
        window.clearTimeout(scrollSaveTimerRef.current)
        scrollSaveTimerRef.current = null
      }
    }
  }, [])

  const selectActive = (id: string) => {
    if (!treeRef.current.nodes[id]) return

    setTree((prev) => ({ ...prev, activeId: id }))

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const anchor = cardTopRefMap.current[id]
        if (anchor && !collapsed) {
          anchor.scrollIntoView({ block: "start", behavior: "auto" })
        }
      })
    })
  }

  const toggleCollapseNode = (id: string) => {
    const cur = !!treeRef.current.collapsedIds?.[id]
    setTree((prev) => ({
      ...prev,
      collapsedIds: {
        ...(prev.collapsedIds ?? {}),
        [id]: !cur
      }
    }))
  }

  const expandAllNodes = () => {
    setTree((prev) => ({
      ...prev,
      collapsedIds: {}
    }))
  }

  const collapseAllOtherNodes = () => {
    setTree((prev) => {
      const nodes = prev.nodes
      const activeId = prev.activeId

      const up: string[] = []
      let cur: string | undefined = activeId
      const guard = new Set<string>()

      while (cur && cur !== ROOT_ID && !guard.has(cur)) {
        guard.add(cur)
        up.push(cur)
        cur = nodes[cur]?.parentId
      }

      const path: string[] = [ROOT_ID, ...up.reverse()]

      const nextCollapsed: Record<string, boolean> = {}

      for (let i = 0; i < path.length - 1; i++) {
        const parentId = path[i]
        const childOnPath = path[i + 1]
        const parent = nodes[parentId]
        if (!parent?.children?.length) continue

        for (const c of parent.children) {
          if (c !== childOnPath) nextCollapsed[c] = true
        }
      }

      const active = nodes[activeId]
      if (active?.children?.length) {
        for (const c of active.children) nextCollapsed[c] = true
      }

      delete nextCollapsed[ROOT_ID]
      delete nextCollapsed[activeId]

      return { ...prev, collapsedIds: nextCollapsed }
    })
  }

  /* ================= ✅ Left resizer (left gap: 8vw ~ 45vw) ================= */

  const PANEL_LEFT_KEY = "treechat:panelLeftVw:v1"

  const [panelLeftVw, setPanelLeftVw] = useState<number>(() => {
    const raw = localStorage.getItem(PANEL_LEFT_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return Math.min(25, Math.max(10, n))
    return 17.15
  })

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_LEFT_KEY, String(panelLeftVw))
    } catch {}
  }, [panelLeftVw])

  const dragLeftRef = useRef<{ dragging: boolean } | null>(null)

  const startResizeLeft = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    dragLeftRef.current = { dragging: true }

    const onMove = (ev: MouseEvent) => {
      if (!dragLeftRef.current?.dragging) return

      const vw = window.innerWidth
      const leftPx = Math.max(0, Math.min(vw, ev.clientX))
      const leftVw = (leftPx / vw) * 100
      const clamped = Math.min(25, Math.max(10, leftVw))
      setPanelLeftVw(clamped)
    }

    const onUp = () => {
      if (dragLeftRef.current) dragLeftRef.current.dragging = false
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  /* ================= ✅ Bottom resizer (distance to bottom: 11%~50%) ================= */

  const PANEL_BOTTOM_KEY = "treechat:panelBottomVh:v1"

  const [panelBottomVh, setPanelBottomVh] = useState<number>(() => {
    const raw = localStorage.getItem(PANEL_BOTTOM_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return Math.min(50, Math.max(10.2, n))
    return 10.2
  })

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_BOTTOM_KEY, String(panelBottomVh))
    } catch {}
  }, [panelBottomVh])

  /* ================= ✅ Copy Code (keep your existing behavior) ================= */

  useEffect(() => {
    const root = document.getElementById("treechat-overlay")
    if (!root) return

    const copyText = async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (err) {
        console.warn("[TreeChat] clipboard.writeText failed, fallback…", err)
      }

      try {
        const ta = document.createElement("textarea")
        ta.value = text
        ta.setAttribute("readonly", "true")
        ta.style.position = "fixed"
        ta.style.left = "-9999px"
        ta.style.top = "0"
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand("copy")
        document.body.removeChild(ta)
        return ok
      } catch (err) {
        console.error("[TreeChat] execCommand copy failed", err)
        return false
      }
    }

    const onClickCapture = async (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return

      const sel = window.getSelection?.()
      if (sel && sel.type === "Range") return

      const btn = target.closest("button") as HTMLButtonElement | null
      if (!btn) return

      const card = btn.closest(".tc-card") as HTMLElement | null
      if (!card) return

      const aria = (btn.getAttribute("aria-label") || "").toLowerCase()
      const title = (btn.getAttribute("title") || "").toLowerCase()
      const textLabel = (btn.textContent || "").trim().toLowerCase()

      const looksLikeCopyCode =
        aria.includes("copy code") ||
        title.includes("copy code") ||
        textLabel === "copy code" ||
        textLabel === "copy"

      if (!looksLikeCopyCode) return

      const pre =
        (btn.closest("pre") as HTMLElement | null) ||
        (card.querySelector("pre") as HTMLElement | null)

      const code = pre?.querySelector("code") as HTMLElement | null
      const text = (code?.innerText || pre?.innerText || "").trim()
      if (!text) return

      e.preventDefault()
      e.stopPropagation()

      const ok = await copyText(text)
      if (!ok) return

      const old = btn.textContent || ""
      btn.textContent = "✓Copied"
      window.setTimeout(() => {
        try {
          btn.textContent = old
        } catch {}
      }, 1200)
    }

    root.addEventListener("click", onClickCapture, true)
    return () => root.removeEventListener("click", onClickCapture, true)
  }, [])

  /* ================= resize dragging ================= */

  const dragRef = useRef<{ dragging: boolean } | null>(null)

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    dragRef.current = { dragging: true }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current?.dragging) return
      const vh = window.innerHeight
      const bottomOffsetPx = Math.max(0, vh - ev.clientY)
      const bottomOffsetVh = (bottomOffsetPx / vh) * 100
      const clamped = Math.min(50, Math.max(10.2, bottomOffsetVh))
      setPanelBottomVh(clamped)
    }

    const onUp = () => {
      if (dragRef.current) dragRef.current.dragging = false
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  /* ================= ✅ Auto lift (follow input box height) ================= */

  const [autoLiftVh, setAutoLiftVh] = useState(0)
  const basePromptHeightRef = useRef<number | null>(null)

  const getPromptEl = (): HTMLElement | null => {
    // ✅ 优先找“会变高的整体输入区/表单容器”
    const form =
      (document.querySelector("form:has([data-testid='prompt-textarea'])") as HTMLElement) ||
      (document.querySelector("form:has(textarea)") as HTMLElement) ||
      (document.querySelector("form:has([contenteditable='true'])") as HTMLElement)

    if (form) return form

    // ✅ contenteditable（新 UI 常见）
    const ce =
      (document.querySelector("[data-testid='prompt-textarea'][contenteditable='true']") as HTMLElement) ||
      (document.querySelector("[contenteditable='true']") as HTMLElement)
    if (ce) return ce

    // ✅ textarea 兜底
    return (
      (document.querySelector('[data-testid="prompt-textarea"]') as HTMLElement) ||
      (document.querySelector("textarea#prompt-textarea") as HTMLElement) ||
      (document.querySelector("form textarea") as HTMLElement) ||
      (document.querySelector("textarea") as HTMLElement)
    )
  }

  useEffect(() => {
    let ro: ResizeObserver | null = null
    let mo: MutationObserver | null = null
    let raf = 0
    let poll = 0

    const apply = () => {
      const el = getPromptEl()
      if (!el) {
        setAutoLiftVh(0)
        return
      }

      const h = el.getBoundingClientRect().height
      if (!Number.isFinite(h) || h <= 0) return

      if (basePromptHeightRef.current == null) {
        basePromptHeightRef.current = h
        setAutoLiftVh(0)
        return
      }

      const base = basePromptHeightRef.current
      const extraPx = Math.max(0, h - base)

      const vh = window.innerHeight || 1
      const extraVh = (extraPx / vh) * 100

      // ✅ 限制最大抬升，避免离谱跳动
      const clamped = Math.min(20, Math.max(0, extraVh))
      setAutoLiftVh(clamped)
    }

    const attach = () => {
      try {
        ro?.disconnect()
      } catch {}

      const el = getPromptEl()
      if (!el) return

      ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => apply())
      })
      ro.observe(el)
    }

    const onResize = () => apply()

    attach()
    apply()

    window.addEventListener("resize", onResize)

    mo = new MutationObserver(() => {
      attach()
      apply()
    })
    mo.observe(document.body, { childList: true, subtree: true })

    // ✅ 兜底：有些情况下 RO 不触发 / 选到的层级不变高
    poll = window.setInterval(() => {
      attach()
      apply()
    }, 250)

    return () => {
      window.removeEventListener("resize", onResize)
      window.clearInterval(poll)
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [])

  /* ================= CSS ================= */

  const scopedCss = `
    /* ================= Theme variables (driven by data-tc-theme) ================= */
    #treechat-overlay {
      --tc-bg: rgba(245,245,245,0.92);
      --tc-panel-bg: rgba(250,250,250,0.92);
      --tc-text: #111;
      --tc-border: rgba(0,0,0,0.12);
      --tc-muted: rgba(0,0,0,0.6);
      --tc-btn-bg: rgba(240,240,240,0.88);
      --tc-btn-border: rgba(0,0,0,0.14);
      --tc-row-bg: rgba(0,0,0,0.05);
      --tc-row-active: rgba(60,120,255,0.18);
      --tc-toggle-bg: rgba(0,0,0,0.05);
      --tc-toggle-border: rgba(0,0,0,0.12);
      --tc-card-top: rgba(255,255,255,0.9);
      --tc-card-bottom: rgba(235,235,235,0.9);
      --tc-mini-bg: rgba(245,245,245,0.92);
      --tc-mini-bg2: rgba(235,235,235,0.86);
      --tc-code-bg: rgba(0,0,0,0.06);
      --tc-danger: #d11;
    }

    #treechat-overlay[data-tc-theme="dark"] {
      --tc-bg: rgba(15,15,15,0.92);
      --tc-panel-bg: rgba(18,18,18,0.88);
      --tc-text: #fff;
      --tc-border: rgba(255,255,255,0.10);
      --tc-muted: rgba(255,255,255,0.65);
      --tc-btn-bg: rgba(30,30,30,0.85);
      --tc-btn-border: rgba(255,255,255,0.16);
      --tc-row-bg: rgba(255,255,255,0.05);
      --tc-row-active: rgba(120,180,255,0.22);
      --tc-toggle-bg: rgba(255,255,255,0.04);
      --tc-toggle-border: rgba(255,255,255,0.12);
      --tc-card-top: rgba(20,20,20,0.70);
      --tc-card-bottom: rgba(70,70,70,0.55);
      --tc-mini-bg: rgba(12,12,12,0.86);
      --tc-mini-bg2: rgba(22,22,22,0.65);
      --tc-code-bg: rgba(255,255,255,0.08);
      --tc-danger: #ff6b6b;
    }

    #treechat-overlay {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      background: var(--tc-bg);
      color: var(--tc-text);
      border-left: 1px solid var(--tc-border);
      backdrop-filter: blur(10px);
      transition: opacity 120ms ease;
    }
    #treechat-overlay * { box-sizing: border-box; }

    /* ✅ 隐藏但不卸载：保留滚动位置 */
    #treechat-overlay.tc-hidden {
      opacity: 0;
      pointer-events: none;
    }

    #treechat-overlay .tc-top {
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      border-bottom: 1px solid var(--tc-border);
    }

    #treechat-overlay .tc-btn {
      all: unset;
      cursor: pointer;
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid var(--tc-btn-border);
      background: var(--tc-btn-bg);
      color: var(--tc-text);
      user-select: none;
    }
    #treechat-overlay .tc-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    #treechat-overlay .tc-body {
      flex: 1;
      min-height: 0;
      display: flex;
    }

    #treechat-overlay .tc-left {
      flex: 1 1 auto;
      min-width: 0;
      overflow: auto;
      padding: 10px;
      overflow-x: hidden !important;
      overflow-y: auto !important;
    }

    /* ✅ node 内部：超出才出现横向滚动条 */
    #treechat-overlay .tc-xscroll {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
    }

    #treechat-overlay .tc-xscroll table {
      width: max-content;
      max-width: none;
      border-collapse: collapse;
    }

    #treechat-overlay .tc-xscroll pre {
      white-space: pre;
      overflow: visible;
    }

    #treechat-overlay .tc-xscroll code {
      white-space: pre;
    }

    #treechat-overlay .tc-card {
      border: 1px solid var(--tc-border);
      border-radius: 12px;
      padding: 8px;
      margin-bottom: 8px;
      background: linear-gradient(180deg, var(--tc-card-top) 0%, var(--tc-card-bottom) 100%);
    }

    #treechat-overlay .tc-card .tc-card-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
    }

    #treechat-overlay .tc-meta {
      font-weight: 800;
      font-size: 12px;
      opacity: 0.9;
    }

    #treechat-overlay .tc-sub {
      font-size: 12px;
      opacity: 0.75;
      margin-bottom: 4px;
    }

    #treechat-overlay .tc-left .tc-html,
    #treechat-overlay .tc-left pre,
    #treechat-overlay .tc-left code {
      max-width: 100% !important;
      color: inherit;
    }

    #treechat-overlay .tc-left a {
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      color: inherit;
      text-decoration: underline;
      opacity: 0.95;
    }

    /* ✅ 右侧结构 */
    #treechat-overlay .tc-right {
      width: 420px;
      flex-shrink: 0;
      border-left: 1px solid var(--tc-border);
      background: var(--tc-panel-bg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      color: var(--tc-text);
      font-family: system-ui, -apple-system, sans-serif;
    }

    #treechat-overlay .tc-right * {
      all: unset;
      box-sizing: border-box;
      color: var(--tc-text);
    }

    #treechat-overlay .tc-right,
    #treechat-overlay .tc-right .tree-btn,
    #treechat-overlay .tc-right .tree-toggle,
    #treechat-overlay .tc-right .tc-structure-head,
    #treechat-overlay .tc-right .tc-structure-list {
      user-select: none !important;
      -webkit-user-select: none !important;
    }

    #treechat-overlay .tc-structure-head {
      padding: 12px;
      border-bottom: 1px solid var(--tc-border);
      display: block;
    }

    #treechat-overlay .tc-structure-title {
      font-weight: 900;
      font-size: 12px;
      display: block;
    }

    #treechat-overlay .tc-structure-hint {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 4px;
      display: block;
      color: var(--tc-muted);
    }

    #treechat-overlay .tc-structure-list {
      flex: 1;
      overflow: auto;
      padding: 10px;
      white-space: nowrap;
    }

    #treechat-overlay .tree-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 2px 0;
      width: fit-content;
      max-width: 100%;
    }

    #treechat-overlay .tree-toggle {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1px solid var(--tc-toggle-border);
      background: var(--tc-toggle-bg);
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      opacity: 0.85;
      flex: 0 0 auto;
    }
    #treechat-overlay .tree-toggle:hover {
      opacity: 1;
      filter: brightness(1.05);
    }
    #treechat-overlay .tree-toggle.placeholder {
      border: none;
      background: transparent;
      cursor: default;
      opacity: 0.35;
    }

    #treechat-overlay .tree-btn {
      display: block;
      text-align: left;
      cursor: pointer;
      padding: 8px 10px;
      margin: 0;
      border-radius: 10px;
      background: var(--tc-row-bg);
      color: var(--tc-text);
    }

    #treechat-overlay .tree-btn.active {
      background: var(--tc-row-active);
    }

    #treechat-overlay .tree-btn .idx {
      font-weight: 900;
      font-size: 12px;
      opacity: 0.9;
      margin-right: 8px;
    }

    #treechat-overlay .tree-btn .ttl {
      font-weight: 900;
      font-size: 12px;
    }

    /* ✅ mini 按钮：永远在（不卸载），同一坐标 */
    #treechat-mini {
      position: fixed;
      left: 88%;
      bottom: 44px;
      z-index: 2147483647;
      background: var(--tc-mini-bg);
      color: var(--tc-text);
      border: 1px solid var(--tc-border);
      border-radius: 12px;
      padding: 6px 8px;
      font-size: 14px;
      cursor: pointer;
      user-select: none;
      backdrop-filter: blur(10px);
    }

    /* 展开态的 mini（显示 Collapse）稍微淡一点 */
    #treechat-mini.is-collapse {
      background: var(--tc-mini-bg2);
      border: 1px solid var(--tc-border);
    }

    /* ✅ bottom resize handle */
    #treechat-overlay .tc-resize-handle {
      height: 10px;
      cursor: ns-resize;
      border-top: 1px solid var(--tc-border);
      background: rgba(255,255,255,0.04);
      flex: 0 0 auto;
    }
    #treechat-overlay[data-tc-theme="light"] .tc-resize-handle {
      background: rgba(0,0,0,0.05);
    }
    #treechat-overlay .tc-resize-handle:hover {
      filter: brightness(1.05);
    }

    /* ✅ left resize handle (vertical bar on overlay's left edge) */
    #treechat-overlay .tc-resize-handle-left {
      position: absolute;
      left: -6px;
      top: 0;
      bottom: 0;
      width: 10px;
      cursor: ew-resize;
      background: rgba(255,255,255,0.03);
      border-right: 1px solid var(--tc-border);
    }
    #treechat-overlay[data-tc-theme="light"] .tc-resize-handle-left {
      background: rgba(0,0,0,0.05);
    }
    #treechat-overlay .tc-resize-handle-left:hover {
      filter: brightness(1.05);
    }
  `

  return (
    <>
      <style>{scopedCss}</style>

      {/* overlay 永远渲染，只是 hidden */}
      <div
        id="treechat-overlay"
        data-tc-theme={tcTheme}
        className={collapsed ? "tc-hidden" : ""}
        // ✅ 关键：bottom = 手动(panelBottomVh) + 自动抬升(autoLiftVh)，但拖拽时禁用自动抬升
        style={{
          left: `${panelLeftVw}vw`,
          bottom: `${Math.min(70, panelBottomVh + (dragRef.current?.dragging ? 0 : autoLiftVh))}vh`
        }}
      >
        <div
          className="tc-resize-handle-left"
          onMouseDown={startResizeLeft}
          title="Drag to resize (left offset 8vw - 45vw)"
        />

        <div className="tc-top">
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", minWidth: 0 }}>
            <div style={{ fontWeight: 900 }}>TreeChat</div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="tc-btn"
              onClick={collapseAllOtherNodes}
              title="Collapse branches outside the active path, and collapse active's direct children"
            >
              Focus
            </button>

            <button className="tc-btn" onClick={expandAllNodes} title="Expand all nodes">
              Expand all
            </button>

            <button
              className="tc-btn"
              onClick={deleteActiveNode}
              title="Delete active node and its descendants"
              style={{ color: "var(--tc-danger)", borderColor: "var(--tc-danger)" }}
            >
              Delete
            </button>

            <button
              className="tc-btn"
              onClick={alignToDom}
              disabled={aligning}
              title="Force align tree with current DOM"
              style={{ background: "rgba(140, 140, 140, 0.55)" }}
            >
              {aligning ? "Aligning..." : "Align"}
            </button>
          </div>
        </div>

        <div className="tc-body">
          {/* LEFT */}
          <div className="tc-left" ref={leftRef}>
            {pathNodes.length === 0 ? (
              <div className="tc-card">No nodes yet. Scroll a bit to load messages.</div>
            ) : (
              pathNodes.map((n) => {
                const live = getLiveHtmlByIndex(n.linearIndex)
                return (
                  <div key={n.id} className="tc-card">
                    <div
                      ref={(el) => {
                        cardTopRefMap.current[n.id] = el
                      }}
                    />

                    <div className="tc-card-head">
                      <div className="tc-meta">
                        [#{n.linearIndex}] {n.summary}
                      </div>
                      <button
                        className="tc-btn"
                        onClick={() => locateInChatGPTAndCollapse(n.linearIndex)}
                        title="Locate this message in ChatGPT and collapse TreeChat"
                      >
                        Locate
                      </button>
                    </div>

                    <div style={{ marginTop: 8 }}>
                      <div className="tc-sub">You</div>
                      <SafeBoundary label="userHtml">
                        <div className="tc-xscroll">
                          <div className="tc-html" dangerouslySetInnerHTML={{ __html: live.userHtml }} />
                        </div>
                      </SafeBoundary>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <div className="tc-sub">Assistant</div>
                      <SafeBoundary label="assistantHtml">
                        <div className="tc-xscroll">
                          <div
                            className="tc-html"
                            dangerouslySetInnerHTML={{ __html: live.assistantHtml }}
                          />
                        </div>
                      </SafeBoundary>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* RIGHT */}
          <div className="tc-right">
            <div className="tc-structure-head">
              <span className="tc-structure-title">Structure</span>
              <span className="tc-structure-hint">
                Click node → set active. Double-click node → locate in ChatGPT.
                <br />
                Click arrow → collapse descendants.
              </span>
            </div>

            <div className="tc-structure-list" ref={rightRef}>
              {flatNodes.length === 0 ? (
                <div style={{ opacity: 0.8, padding: 10 }}>(empty)</div>
              ) : (
                flatNodes.map((n) => {
                  const isActive = n.id === tree.activeId
                  const canToggle = hasChildren(tree, n.id)
                  const isCollapsedNode = !!tree.collapsedIds?.[n.id]

                  // ✅ NEW: 不在当前 active branch 的 node 显示淡一点
                  const inActiveBranch = activePathIds.has(n.id)

                  return (
                    <div key={n.id} className="tree-row" style={{ marginLeft: n.depth * INDENT_PX }}>
                      <div
                        className={`tree-toggle ${canToggle ? "" : "placeholder"}`}
                        title={canToggle ? (isCollapsedNode ? "Expand" : "Collapse") : ""}
                        onClick={(e: any) => {
                          e.stopPropagation()
                          if (!canToggle) return
                          toggleCollapseNode(n.id)
                        }}
                        style={
                          !inActiveBranch && !isActive
                            ? { opacity: 0.35, filter: "grayscale(1)" }
                            : undefined
                        }
                      >
                        {canToggle ? (isCollapsedNode ? "▶" : "▼") : "•"}
                      </div>

                      <div
                        className={`tree-btn ${isActive ? "active" : ""}`}
                        onClick={() => selectActive(n.id)}
                        onDoubleClick={() => locateInChatGPTAndCollapse(n.linearIndex)}
                        title="Click: set active · Double-click: locate"
                        style={{
                          width: "fit-content",
                          maxWidth: "100%",
                          opacity: !inActiveBranch && !isActive ? 0.45 : 1,
                          filter: !inActiveBranch && !isActive ? "grayscale(1)" : "none"
                        }}
                      >
                        <span className="idx">[#{n.linearIndex}]</span>
                        <span className="ttl">{n.summary}</span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        <div
          className="tc-resize-handle"
          onMouseDown={startResize}
          title="Drag to resize (bottom offset 11% - 50%)"
        />
      </div>

      {/* ✅ mini 永远在：同坐标，点击切换（不动） */}
      <div
        id="treechat-mini"
        className={collapsed ? "" : "is-collapse"}
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand" : "Collapse"}
        style={
          tcTheme === "dark"
            ? {
                background: "rgba(12,12,12,0.86)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.10)"
              }
            : {
                background: "rgba(245,245,245,0.92)",
                color: "#111",
                border: "1px solid rgba(0,0,0,0.12)"
              }
        }
      >
        {collapsed ? "▶ TreeChat" : "Collapse"}
      </div>
    </>
  )
}
