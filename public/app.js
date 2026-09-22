/* Codeplay DAG panel — live view driven by SSE from the pi extension. */
/* global cytoscape */

(function () {
  "use strict";

  var STATUS_LABEL = { pending: "未开始", active: "进行中", done: "已完成" };

  var cy = cytoscape({
    // （调试/测试挂钩）
    ready: function (e) { window.__cy = e.cy; },
    container: document.getElementById("cy"),
    style: [
      {
        selector: "node",
        style: {
          label: "data(name)",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "120px",
          color: "#1f2328",
          "font-size": 12,
          "font-weight": 600,
          width: "label",
          height: "label",
          padding: "12px",
          shape: "round-rectangle",
          "border-width": 1,
          "border-color": "#d3d9e0",
          "transition-property": "background-color, border-color",
          "transition-duration": 200,
        },
      },
      { selector: "node.pending", style: { "background-color": "#e5e8ee" } },
      { selector: "node.active", style: { "background-color": "#fde68a", "border-color": "#f59e0b" } },
      { selector: "node.done", style: { "background-color": "#bbf7d0", "border-color": "#4ade80" } },
      {
        selector: "node:selected",
        style: { "border-color": "#3b82f6", "border-width": 2 },
      },
      {
        selector: "edge",
        style: {
          label: "data(note)",
          "font-size": 10,
          color: "#8a919e",
          "text-margin-y": -10,
          "text-background-color": "#fbfcfd",
          "text-background-opacity": 0.95,
          "text-background-padding": "3px",
          "text-background-shape": "round-rectangle",
          width: 1.25,
          "line-color": "#c3cbd6",
          "target-arrow-color": "#c3cbd6",
          "target-arrow-shape": "triangle",
          "arrow-scale": 1.1,
          "curve-style": "bezier",
        },
      },
      {
        selector: "edge:selected",
        style: { "line-color": "#3b82f6", "target-arrow-color": "#3b82f6", width: 2 },
      },
    ],
    wheelSensitivity: 0.3,
  });

  // -- layout ---------------------------------------------------------------

  function runLayout(animate) {
    cy.layout({
      name: "dagre",
      rankDir: "TB",
      nodeSep: 40,
      rankSep: 70,
      edgeSep: 12,
      animate: !!animate,
      animationDuration: 250,
      fit: true,
      padding: 40,
    }).run();
  }

  // fit 会把少量节点放得过大——布局后把缩放钳制回 1 以内，只居中不放大
  function clampZoom() {
    if (cy.elements().length === 0) return;
    if (cy.zoom() > 1) {
      cy.zoom(1);
      cy.center();
    }
  }
  cy.on("layoutstop", clampZoom);

  // -- incremental graph update ----------------------------------------------

  var lastStructureKey = "";

  function structureKey(graph) {
    var ns = graph.nodes.map(function (n) { return n.id; }).sort().join(",");
    var es = graph.edges.map(function (e) { return e.id + ":" + e.source + ">" + e.target; }).sort().join(",");
    return ns + "|" + es;
  }

  function applyGraph(graph) {
    var structural = structureKey(graph) !== lastStructureKey;
    lastStructureKey = structureKey(graph);

    var seen = {};
    graph.nodes.forEach(function (n) {
      seen[n.id] = true;
      var ele = cy.getElementById(n.id);
      var data = { id: n.id, name: n.name, brief: n.brief || "", files: n.files || [], status: n.status };
      if (ele.nonempty()) {
        ele.data(data);
        ele.removeClass("pending active done").addClass(n.status);
      } else {
        cy.add({ group: "nodes", data: data, classes: n.status });
      }
    });

    graph.edges.forEach(function (e) {
      seen[e.id] = true;
      var ele = cy.getElementById(e.id);
      var data = { id: e.id, source: e.source, target: e.target, note: e.note || "" };
      if (ele.nonempty()) {
        ele.data(data);
      } else {
        cy.add({ group: "edges", data: data });
      }
    });

    cy.elements().forEach(function (ele) {
      if (!seen[ele.id()]) cy.remove(ele);
    });

    messages = Array.isArray(graph.messages) ? graph.messages : [];
    renderBadge();
    if (!annPanel.classList.contains("hidden")) renderAnn();

    document.getElementById("empty").classList.toggle("hidden", graph.nodes.length > 0);

    if (structural) runLayout(false);
  }

  function setProjectName(name) {
    if (!name) return;
    document.title = name + " · Codeplay DAG";
    var pill = document.getElementById("project-name");
    pill.textContent = name;
    pill.classList.remove("hidden");
  }

  // -- detail panel -----------------------------------------------------------

  var panel = document.getElementById("panel");
  var panelBody = document.getElementById("panel-body");

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showNode(d) {
    toggleAnn(false);
    var files = (d.files || []);
    panelBody.innerHTML =
      "<h2>" + esc(d.name) + '<span class="badge ' + esc(d.status) + '">' + esc(STATUS_LABEL[d.status] || d.status) + "</span></h2>" +
      '<div class="meta">节点 ' + esc(d.id) + "</div>" +
      '<div class="section-title">简介</div>' +
      (d.brief ? '<div class="brief">' + esc(d.brief) + "</div>" : '<div class="none">（无）</div>') +
      '<div class="section-title">囊括文件 (' + files.length + ")</div>" +
      (files.length
        ? '<ul class="files">' + files.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>"
        : '<div class="none">（无）</div>');
    panel.classList.remove("hidden");
  }

  function showEdge(d) {
    toggleAnn(false);
    panelBody.innerHTML =
      "<h2>边 " + esc(d.id) + "</h2>" +
      '<div class="edge-flow"><span>' + esc(d.source) + '</span><span class="arrow">→</span><span>' + esc(d.target) + "</span></div>" +
      '<div class="section-title">备注</div>' +
      (d.note ? '<div class="brief">' + esc(d.note) + "</div>" : '<div class="none">（无）</div>');
    panel.classList.remove("hidden");
  }

  function hidePanel() {
    panel.classList.add("hidden");
  }

  cy.on("tap", "node", function (evt) { showNode(evt.target.data()); });
  cy.on("tap", "edge", function (evt) { showEdge(evt.target.data()); });
  cy.on("tap", function (evt) { if (evt.target === cy) hidePanel(); });
  document.getElementById("panel-close").addEventListener("click", hidePanel);

  // -- announcements ------------------------------------------------------------

  var messages = [];
  var annPanel = document.getElementById("ann-panel");
  var annList = document.getElementById("ann-list");
  var annBadge = document.getElementById("ann-badge");

  function lastReadId() {
    try { return localStorage.getItem("ann_last_read"); } catch (e) { return null; }
  }
  function setLastRead(id) {
    try { localStorage.setItem("ann_last_read", id); } catch (e) { /* ignore */ }
  }
  function unreadCount() {
    if (messages.length === 0) return 0;
    var lr = lastReadId();
    if (!lr) return messages.length;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].id === lr) return messages.length - i - 1;
    }
    return messages.length;
  }
  function renderBadge() {
    var n = unreadCount();
    annBadge.textContent = String(n);
    annBadge.classList.toggle("hidden", n === 0);
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function renderAnn() {
    if (messages.length === 0) {
      annList.innerHTML = '<div class="none">暂无消息</div>';
      return;
    }
    annList.innerHTML = messages.slice().reverse().map(function (m) {
      return '<div class="ann-item"><div class="ann-time">' + fmtTime(m.ts) + '</div><div class="ann-text">' + esc(m.text) + "</div></div>";
    }).join("");
  }
  function toggleAnn(force) {
    var show = typeof force === "boolean" ? force : annPanel.classList.contains("hidden");
    if (show) {
      hidePanel();
      renderAnn();
      annPanel.classList.remove("hidden");
      if (messages.length > 0) setLastRead(messages[messages.length - 1].id);
      renderBadge();
    } else {
      annPanel.classList.add("hidden");
    }
  }

  document.getElementById("btn-ann").addEventListener("click", function () { toggleAnn(); });
  document.getElementById("ann-close").addEventListener("click", function () { toggleAnn(false); });

  document.getElementById("btn-relayout").addEventListener("click", function () { runLayout(true); });
  document.getElementById("btn-fit").addEventListener("click", function () { cy.fit(undefined, 40); });

  // -- live data: SSE with polling fallback ------------------------------------

  var conn = document.getElementById("conn");
  var pollTimer = null;

  function setConn(online, text) {
    conn.className = "conn " + (online ? "online" : "offline");
    conn.textContent = text;
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch("api/graph")
        .then(function (r) { return r.json(); })
        .then(function (g) { setConn(true, "轮询中"); applyGraph(g); })
        .catch(function () { setConn(false, "已断开"); });
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function connect() {
    var es = new EventSource("api/events");
    es.onopen = function () { setConn(true, "实时连接"); stopPolling(); };
    es.onmessage = function (evt) {
      try { applyGraph(JSON.parse(evt.data)); } catch (e) { /* ignore bad payload */ }
    };
    es.onerror = function () {
      setConn(false, "重连中…");
      startPolling();
      // EventSource auto-reconnects; nothing else to do.
    };
  }

  // project name = the working directory's folder name (from the hub)
  fetch("api/info")
    .then(function (r) { return r.json(); })
    .then(function (info) { setProjectName(info.project); })
    .catch(function () { /* ignore */ });

  // initial fetch, then live updates
  fetch("api/graph")
    .then(function (r) { return r.json(); })
    .then(function (g) { applyGraph(g); connect(); })
    .catch(function () { setConn(false, "无法连接服务"); startPolling(); connect(); });
})();
