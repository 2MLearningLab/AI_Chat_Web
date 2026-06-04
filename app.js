const storageKey = "ai-chat-web-state-v1";
const maxAttachments = 6;
const maxAttachmentBytes = 10 * 1024 * 1024;
const maxTotalAttachmentBytes = 30 * 1024 * 1024;
const maxTextChars = 80000;
const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const supportedTextExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".log"
]);

const elements = {
  conversationList: document.querySelector("#conversation-list"),
  newChat: document.querySelector("#new-chat"),
  clearChat: document.querySelector("#clear-chat"),
  chatTitle: document.querySelector("#chat-title"),
  statusLine: document.querySelector("#status-line"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  attachmentTray: document.querySelector("#attachment-tray"),
  fileInput: document.querySelector("#file-input"),
  attachButton: document.querySelector("#attach-button"),
  dropHint: document.querySelector("#drop-hint"),
  promptInput: document.querySelector("#prompt-input"),
  sendButton: document.querySelector("#send-button"),
  stopButton: document.querySelector("#stop-button"),
  modeSelect: document.querySelector("#mode-select"),
  depthControl: document.querySelector("#depth-control"),
  cwdInput: document.querySelector("#cwd-input"),
  modelInput: document.querySelector("#model-input"),
  webSearchToggle: document.querySelector("#web-search-toggle"),
  allowWriteToggle: document.querySelector("#allow-write-toggle")
};

let state = loadState();
let activeRequest = null;
let pendingAttachments = [];
let dragDepth = 0;

hydrateControls();
render();

elements.newChat.addEventListener("click", () => {
  const conversation = createConversation();
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  saveState();
  render();
  elements.promptInput.focus();
});

elements.clearChat.addEventListener("click", () => {
  const conversation = getActiveConversation();
  if (!conversation || activeRequest) {
    return;
  }
  conversation.messages = [];
  conversation.title = "新会话";
  conversation.updatedAt = Date.now();
  saveState();
  render();
});

elements.composer.addEventListener("submit", event => {
  event.preventDefault();
  sendPrompt();
});

elements.promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

elements.promptInput.addEventListener("input", () => {
  autoSizePrompt();
});

elements.stopButton.addEventListener("click", () => {
  if (activeRequest) {
    activeRequest.abort();
  }
});

elements.attachButton.addEventListener("click", () => {
  if (!activeRequest) {
    elements.fileInput.click();
  }
});

elements.fileInput.addEventListener("change", event => {
  addFiles(event.target.files);
  elements.fileInput.value = "";
});

elements.attachmentTray.addEventListener("click", event => {
  const button = event.target.closest("button[data-remove-attachment]");
  if (!button) {
    return;
  }
  removePendingAttachment(button.dataset.removeAttachment);
});

window.addEventListener("dragenter", event => {
  if (!hasFiles(event.dataTransfer)) {
    return;
  }
  event.preventDefault();
  dragDepth += 1;
  elements.composer.classList.add("drag-active");
});

window.addEventListener("dragover", event => {
  if (!hasFiles(event.dataTransfer)) {
    return;
  }
  event.preventDefault();
});

window.addEventListener("dragleave", event => {
  if (!hasFiles(event.dataTransfer)) {
    return;
  }
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    elements.composer.classList.remove("drag-active");
  }
});

window.addEventListener("drop", event => {
  if (!hasFiles(event.dataTransfer)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  elements.composer.classList.remove("drag-active");
  addFiles(event.dataTransfer.files);
});

window.addEventListener("paste", event => {
  const files = Array.from(event.clipboardData?.files || []);
  if (files.length === 0) {
    return;
  }
  addFiles(files);
});

elements.modeSelect.addEventListener("change", () => {
  state.settings.mode = elements.modeSelect.value;
  saveState();
});

elements.cwdInput.addEventListener("change", () => {
  state.settings.cwd = elements.cwdInput.value.trim() || "/home/ubuntu/projects";
  elements.cwdInput.value = state.settings.cwd;
  saveState();
});

elements.modelInput.addEventListener("change", () => {
  state.settings.model = elements.modelInput.value.trim();
  saveState();
});

elements.webSearchToggle.addEventListener("change", () => {
  state.settings.webSearch = elements.webSearchToggle.checked;
  saveState();
});

elements.allowWriteToggle.addEventListener("change", () => {
  state.settings.allowWrite = elements.allowWriteToggle.checked;
  saveState();
});

elements.depthControl.addEventListener("click", event => {
  const button = event.target.closest("button[data-depth]");
  if (!button) {
    return;
  }
  state.settings.depth = button.dataset.depth;
  saveState();
  hydrateControls();
});

elements.conversationList.addEventListener("click", event => {
  const button = event.target.closest("button[data-id]");
  if (!button) {
    return;
  }
  state.activeId = button.dataset.id;
  saveState();
  render();
});

elements.messages.addEventListener("click", async event => {
  const button = event.target.closest("button[data-copy-id]");
  if (!button) {
    return;
  }
  const conversation = getActiveConversation();
  const message = conversation?.messages.find(item => item.id === button.dataset.copyId);
  if (!message) {
    return;
  }
  await navigator.clipboard.writeText(message.content);
  button.textContent = "已复制";
  setTimeout(() => {
    button.textContent = "复制";
  }, 1000);
});

async function sendPrompt() {
  const text = elements.promptInput.value.trim();
  const attachmentsToSend = pendingAttachments;
  const conversation = getActiveConversation();
  if ((!text && attachmentsToSend.length === 0) || !conversation || activeRequest) {
    return;
  }

  const userContent = text || "请根据附件回答。";
  const userMessage = {
    id: createId(),
    role: "user",
    content: userContent,
    attachments: summarizeAttachments(attachmentsToSend),
    createdAt: Date.now()
  };
  const assistantMessage = {
    id: createId(),
    role: "assistant",
    content: "",
    pending: true,
    createdAt: Date.now()
  };

  conversation.messages.push(userMessage, assistantMessage);
  conversation.title = titleFromMessage(userContent, attachmentsToSend);
  conversation.updatedAt = Date.now();
  elements.promptInput.value = "";
  pendingAttachments = [];
  autoSizePrompt();
  renderAttachmentTray();
  setBusy(true);
  setStatus("正在发送...");
  saveState();
  render();

  const controller = new AbortController();
  activeRequest = controller;

  try {
    const payloadMessages = conversation.messages
      .filter(message => !message.pending)
      .map(message => ({
        role: message.role,
        content: message.content
      }));

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: payloadMessages,
        settings: state.settings,
        attachments: attachmentsToSend.map(toPayloadAttachment)
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.json().catch(() => null);
      throw new Error(errorBody?.error || `请求失败：${response.status}`);
    }

    await readEventStream(response, event => {
      if (event.type === "status") {
        setStatus(event.message);
      }

      if (event.type === "message") {
        assistantMessage.content = event.content || "";
        assistantMessage.pending = false;
        conversation.updatedAt = Date.now();
        saveState();
        renderMessages();
      }

      if (event.type === "usage" && event.usage) {
        assistantMessage.usage = event.usage;
        saveState();
        renderMessages();
      }

      if (event.type === "error") {
        throw new Error(event.message || "生成失败。");
      }
    });

    assistantMessage.pending = false;
    if (!assistantMessage.content.trim()) {
      assistantMessage.content = "没有收到可显示的回复。";
    }
    setStatus("就绪");
  } catch (error) {
    if (error.name === "AbortError") {
      assistantMessage.pending = false;
      assistantMessage.content = assistantMessage.content || "已停止。";
      setStatus("已停止");
    } else {
      assistantMessage.pending = false;
      assistantMessage.error = true;
      assistantMessage.content = error.message || "生成失败。";
      setStatus("生成失败");
    }
  } finally {
    activeRequest = null;
    setBusy(false);
    conversation.updatedAt = Date.now();
    saveState();
    render();
    elements.promptInput.focus();
  }
}

async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      onEvent(JSON.parse(line));
    }
  }

  if (buffer.trim()) {
    onEvent(JSON.parse(buffer));
  }
}

function render() {
  renderConversations();
  renderHeader();
  renderMessages();
  hydrateControls();
}

function renderConversations() {
  elements.conversationList.innerHTML = state.conversations
    .map(conversation => {
      const activeClass = conversation.id === state.activeId ? " active" : "";
      const count = conversation.messages.filter(message => message.role === "user").length;
      return `
        <button class="conversation-button${activeClass}" type="button" data-id="${conversation.id}">
          <div class="conversation-title">${escapeHtml(conversation.title)}</div>
          <div class="conversation-meta">${count} 条消息</div>
        </button>
      `;
    })
    .join("");
}

function renderHeader() {
  const conversation = getActiveConversation();
  elements.chatTitle.textContent = conversation?.title || "新会话";
}

function renderMessages() {
  const conversation = getActiveConversation();
  if (!conversation || conversation.messages.length === 0) {
    elements.messages.innerHTML = `<div class="empty-state">开始新的对话</div>`;
    return;
  }

  elements.messages.innerHTML = conversation.messages
    .map(message => {
      const roleLabel = message.role === "user" ? "你" : "AI";
      const copyButton = message.role === "assistant" && message.content
        ? `<button class="copy-button" type="button" data-copy-id="${message.id}">复制</button>`
        : "";
      const pendingClass = message.pending ? " pending" : "";
      const errorClass = message.error ? " error-text" : "";
      const usage = message.usage ? renderUsage(message.usage) : "";
      const content = message.pending && !message.content ? "正在生成..." : message.content;
      const attachments = renderMessageAttachments(message.attachments || []);

      return `
        <article class="message-row ${message.role}">
          <div class="message">
            <div class="message-meta">
              <span>${roleLabel}</span>
              ${copyButton}
            </div>
            <div class="bubble${pendingClass}">
              ${attachments}
              <div class="content${errorClass}">${renderMarkdown(content)}</div>
              ${usage}
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderUsage(usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return `<div class="usage">输入 ${input} tokens · 输出 ${output} tokens</div>`;
}

function renderAttachmentTray() {
  if (pendingAttachments.length === 0) {
    elements.attachmentTray.classList.add("hidden");
    elements.attachmentTray.innerHTML = "";
    return;
  }

  elements.attachmentTray.classList.remove("hidden");
  elements.attachmentTray.innerHTML = pendingAttachments
    .map(item => {
      const preview = item.kind === "image"
        ? `<img src="${item.previewUrl}" alt="">`
        : `<span class="attachment-icon">TXT</span>`;
      const warning = item.truncated ? `<span class="attachment-warning">已截断</span>` : "";
      return `
        <div class="attachment-chip">
          ${preview}
          <div class="attachment-main">
            <div class="attachment-name">${escapeHtml(item.name)}</div>
            <div class="attachment-meta">${item.kind === "image" ? "图片" : "文本"} · ${formatBytes(item.size)} ${warning}</div>
          </div>
          <button type="button" aria-label="移除附件" data-remove-attachment="${item.id}">×</button>
        </div>
      `;
    })
    .join("");
}

function renderMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }

  return `
    <div class="message-attachments">
      ${attachments
        .map(item => `
          <span class="message-attachment">
            ${item.kind === "image" ? "图片" : "文本"} · ${escapeHtml(item.name)} · ${formatBytes(item.size || 0)}
          </span>
        `)
        .join("")}
    </div>
  `;
}

function hydrateControls() {
  elements.modeSelect.value = state.settings.mode;
  elements.cwdInput.value = state.settings.cwd;
  elements.modelInput.value = state.settings.model || "";
  elements.webSearchToggle.checked = state.settings.webSearch;
  elements.allowWriteToggle.checked = state.settings.allowWrite;

  for (const button of elements.depthControl.querySelectorAll("button[data-depth]")) {
    button.classList.toggle("active", button.dataset.depth === state.settings.depth);
  }
}

function setBusy(isBusy) {
  elements.sendButton.disabled = isBusy;
  elements.promptInput.disabled = isBusy;
  elements.attachButton.disabled = isBusy;
  elements.stopButton.classList.toggle("hidden", !isBusy);
}

function setStatus(text) {
  elements.statusLine.textContent = text;
}

async function addFiles(fileList) {
  if (activeRequest) {
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  const rejected = [];
  let totalBytes = pendingAttachments.reduce((sum, item) => sum + (item.size || 0), 0);

  for (const file of files) {
    if (pendingAttachments.length >= maxAttachments) {
      rejected.push(`一次最多 ${maxAttachments} 个附件。`);
      break;
    }

    const kind = classifyFile(file);
    const name = file.name || defaultAttachmentName(kind);

    if (!kind) {
      rejected.push(`${name} 暂不支持。`);
      continue;
    }

    if (file.size > maxAttachmentBytes) {
      rejected.push(`${name} 超过 10MB。`);
      continue;
    }

    if (totalBytes + file.size > maxTotalAttachmentBytes) {
      rejected.push(`${name} 超出本次 30MB 总附件限制。`);
      continue;
    }

    if (kind === "image") {
      const data = await readFileAsDataUrl(file);
      totalBytes += file.size;
      pendingAttachments.push({
        id: createId(),
        kind,
        name,
        type: file.type,
        size: file.size,
        data,
        previewUrl: data
      });
      continue;
    }

    const rawText = await file.text();
    totalBytes += file.size;
    pendingAttachments.push({
      id: createId(),
      kind,
      name,
      type: file.type || "text/plain",
      size: file.size,
      text: rawText.slice(0, maxTextChars),
      truncated: rawText.length > maxTextChars
    });
  }

  renderAttachmentTray();
  if (rejected.length > 0) {
    setStatus(rejected.slice(0, 2).join(" "));
  } else {
    setStatus(`${pendingAttachments.length} 个附件待发送`);
  }
  elements.promptInput.focus();
}

function removePendingAttachment(id) {
  pendingAttachments = pendingAttachments.filter(item => item.id !== id);
  renderAttachmentTray();
  setStatus(pendingAttachments.length ? `${pendingAttachments.length} 个附件待发送` : "就绪");
}

function summarizeAttachments(attachments) {
  return attachments.map(item => ({
    kind: item.kind,
    name: item.name,
    type: item.type,
    size: item.size,
    truncated: item.truncated === true
  }));
}

function toPayloadAttachment(item) {
  if (item.kind === "image") {
    return {
      kind: "image",
      name: item.name,
      type: item.type,
      size: item.size,
      data: item.data
    };
  }

  return {
    kind: "text",
    name: item.name,
    type: item.type,
    size: item.size,
    text: item.text,
    truncated: item.truncated === true
  };
}

function classifyFile(file) {
  const type = String(file.type || "").toLowerCase();
  const extension = extensionOf(file.name || "");

  if (supportedImageTypes.has(type)) {
    return "image";
  }

  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/x-yaml" ||
    supportedTextExtensions.has(extension)
  ) {
    return "text";
  }

  return "";
}

function hasFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("Files");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取文件失败。")));
    reader.readAsDataURL(file);
  });
}

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function defaultAttachmentName(kind) {
  if (kind === "image") {
    return `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  }
  return "attachment.txt";
}

function autoSizePrompt() {
  elements.promptInput.style.height = "auto";
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`;
}

function getActiveConversation() {
  let conversation = state.conversations.find(item => item.id === state.activeId);
  if (!conversation) {
    conversation = state.conversations[0] || createConversation();
    state.activeId = conversation.id;
    if (!state.conversations.includes(conversation)) {
      state.conversations.unshift(conversation);
    }
  }
  return conversation;
}

function createConversation() {
  const now = Date.now();
  return {
    id: createId(),
    title: "新会话",
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function loadState() {
  const fallback = {
    activeId: "",
    conversations: [],
    settings: {
      mode: "chat",
      depth: "short",
      cwd: "/home/ubuntu/projects",
      model: "",
      webSearch: false,
      allowWrite: false,
      timeoutMs: 300000
    }
  };

  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    const conversation = createConversation();
    return {
      ...fallback,
      activeId: conversation.id,
      conversations: [conversation]
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const conversations = Array.isArray(parsed.conversations) && parsed.conversations.length
      ? parsed.conversations
      : [createConversation()];

    return {
      ...fallback,
      ...parsed,
      conversations,
      activeId: parsed.activeId || conversations[0].id,
      settings: {
        ...fallback.settings,
        ...(parsed.settings || {})
      }
    };
  } catch {
    const conversation = createConversation();
    return {
      ...fallback,
      activeId: conversation.id,
      conversations: [conversation]
    };
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function titleFromMessage(text, attachments = []) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact && attachments.length > 0) {
    return `${attachments.length} 个附件`;
  }
  return compact.length > 28 ? `${compact.slice(0, 28)}...` : compact || "新会话";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function renderMarkdown(raw) {
  const text = String(raw || "");
  const segments = text.split("```");
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.replace(/^\n/, "").split("\n");
        if (/^[a-z0-9_+-]+$/i.test(lines[0] || "")) {
          lines.shift();
        }
        return `<pre><code>${escapeHtml(lines.join("\n").trimEnd())}</code></pre>`;
      }
      return renderParagraphs(segment);
    })
    .join("");
}

function renderParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => `<p>${renderInline(part).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderInline(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
