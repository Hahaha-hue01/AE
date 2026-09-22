/*
 * AE 脚本集合器内置脚本
 * 文字管理器 v6.0
 * 兼容 After Effects CS6 ~ AE2026（ExtendScript ES3）
 *
 * 功能：扫描合成/预合成中的文字图层，批量替换文字、查找替换、改字体、
 * 调整字间距和行距。脚本只修改文字图层的 TextDocument，不改变图层结构。
 */
#target aftereffects

(function (host) {
    var SCRIPT_NAME = "文字管理器";
    var SCRIPT_VERSION = "6.0";
    var state = {
        rows: [],
        selected: [],
        filterText: "",
        language: "全部",
        ignoreHidden: false,
        scanned: 0,
        failed: 0
    };

    function trim(value) {
        return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
    }

    function safeName(item, fallback) {
        try {
            if (item && item.name) {
                return String(item.name);
            }
        } catch (e) {}
        return fallback || "未命名";
    }

    function isTextLayer(layer) {
        try {
            return layer && layer.property("Source Text") !== null;
        } catch (e) {
            return false;
        }
    }

    function isComp(item) {
        try {
            return item instanceof CompItem;
        } catch (e) {
            return false;
        }
    }

    function getTextDocument(layer) {
        try {
            var prop = layer.property("Source Text");
            if (!prop) {
                return null;
            }
            return prop.value;
        } catch (e) {
            return null;
        }
    }

    function setTextDocument(layer, doc) {
        var prop = layer.property("Source Text");
        if (!prop || !doc) {
            throw new Error("无法访问 Source Text 属性");
        }
        prop.setValue(doc);
    }

    function languageOf(text) {
        var value = String(text || "");
        if (/[\u4e00-\u9fff]/.test(value)) {
            return "中文";
        }
        if (/[\u3040-\u30ff]/.test(value)) {
            return "日文";
        }
        if (/[\uac00-\ud7af]/.test(value)) {
            return "韩文";
        }
        if (/[A-Za-z]/.test(value)) {
            return "英文";
        }
        return "其他";
    }

    function matches(row) {
        var q = state.filterText.toLowerCase();
        if (q && row.text.toLowerCase().indexOf(q) < 0 && row.layerName.toLowerCase().indexOf(q) < 0) {
            return false;
        }
        if (state.language !== "全部" && languageOf(row.text) !== state.language) {
            return false;
        }
        return true;
    }

    function addRowsFromComp(comp, result, visited) {
        if (!comp || visited[comp.id]) {
            return;
        }
        visited[comp.id] = true;
        var i;
        for (i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (state.ignoreHidden && !layer.enabled) {
                    continue;
                }
                if (isTextLayer(layer)) {
                    var doc = getTextDocument(layer);
                    result.push({
                        layer: layer,
                        comp: comp,
                        text: doc && doc.text !== undefined ? String(doc.text) : "",
                        layerName: safeName(layer, "文字图层"),
                        compName: safeName(comp, "合成")
                    });
                }
                try {
                    if (layer.source && isComp(layer.source)) {
                        addRowsFromComp(layer.source, result, visited);
                    }
                } catch (nestedError) {}
            } catch (layerError) {
                state.failed++;
            }
        }
    }

    function addFromItem(item, result, visited) {
        if (!item) {
            return;
        }
        try {
            if (isComp(item)) {
                addRowsFromComp(item, result, visited);
            } else if (item instanceof FolderItem) {
                var i;
                for (i = 1; i <= item.numItems; i++) {
                    addFromItem(item.item(i), result, visited);
                }
            }
        } catch (e) {
            state.failed++;
        }
    }

    function scanProject(mode) {
        state.rows = [];
        state.selected = [];
        state.failed = 0;
        if (!app.project) {
            return { count: 0, message: "请先打开一个 AE 项目" };
        }
        var result = [];
        var visited = {};
        try {
            if (mode === "active" && app.project.activeItem && isComp(app.project.activeItem)) {
                addFromItem(app.project.activeItem, result, visited);
            } else {
                var selection = app.project.selection;
                if (selection && selection.length) {
                    var i;
                    for (i = 0; i < selection.length; i++) {
                        addFromItem(selection[i], result, visited);
                    }
                } else if (app.project.activeItem && isComp(app.project.activeItem)) {
                    addFromItem(app.project.activeItem, result, visited);
                } else {
                    for (i = 1; i <= app.project.numItems; i++) {
                        addFromItem(app.project.item(i), result, visited);
                    }
                }
            }
        } catch (e) {
            return { count: 0, message: "扫描失败：" + e.toString() };
        }
        state.rows = result;
        state.scanned = result.length;
        return { count: result.length, message: "扫描完成，共找到 " + result.length + " 个文字图层" };
    }

    function selectedRows(list) {
        var output = [];
        var i;
        if (!list) {
            return output;
        }
        for (i = 0; i < list.items.length; i++) {
            if (list.items[i].selected && list.items[i].rowData) {
                output.push(list.items[i].rowData);
            }
        }
        return output;
    }

    function refreshList(list, status) {
        list.removeAll();
        var shown = 0;
        var i;
        for (i = 0; i < state.rows.length; i++) {
            if (matches(state.rows[i])) {
                var row = list.add("item", state.rows[i].layerName + "  |  " + state.rows[i].text);
                row.rowData = state.rows[i];
                shown++;
            }
        }
        if (status) {
            status.text = "显示 " + shown + " / " + state.rows.length + " 个图层" + (state.failed ? "，跳过 " + state.failed + " 个异常项" : "");
        }
    }

    function eachText(list, callback) {
        var rows = selectedRows(list);
        if (!rows.length) {
            throw new Error("请先在列表中选择文字图层");
        }
        var ok = 0;
        var failed = 0;
        var i;
        app.beginUndoGroup(SCRIPT_NAME);
        try {
            for (i = 0; i < rows.length; i++) {
                try {
                    if (rows[i].layer.locked) {
                        throw new Error("图层已锁定");
                    }
                    callback(rows[i]);
                    ok++;
                } catch (e) {
                    failed++;
                }
            }
        } finally {
            app.endUndoGroup();
        }
        return { ok: ok, failed: failed };
    }

    function report(status, result, action) {
        status.text = action + "完成：成功 " + result.ok + " 个" + (result.failed ? "，失败 " + result.failed + " 个" : "");
    }

    function promptValue(title, message, initial) {
        var value = prompt(message, initial === undefined ? "" : initial);
        if (value === null) {
            return null;
        }
        return String(value);
    }

    function showHelp() {
        alert(SCRIPT_NAME + " v" + SCRIPT_VERSION + "\n\n" +
            "扫描当前合成、项目选择项或整个项目中的文字图层。\n" +
            "支持批量替换、查找替换、改字体、字间距和行距。\n\n" +
            "提示：锁定图层会被跳过；所有批量修改都可以用 AE 的撤销恢复。\n" +
            "这是集合器内置脚本，不会改变项目文件夹或合成结构。", SCRIPT_NAME);
    }

    function buildUI(parent) {
        var win = parent instanceof Panel ? parent : new Window("palette", SCRIPT_NAME + " v" + SCRIPT_VERSION, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 6;
        win.margins = 10;

        var header = win.add("group");
        header.orientation = "row";
        header.alignChildren = ["left", "center"];
        var title = header.add("statictext", undefined, SCRIPT_NAME + "  v" + SCRIPT_VERSION);
        title.alignment = ["left", "center"];
        var help = header.add("button", undefined, "帮助");
        help.preferredSize = [52, 24];
        help.onClick = showHelp;

        var source = win.add("panel", undefined, "扫描范围");
        source.orientation = "row";
        source.alignChildren = ["left", "center"];
        var scanActive = source.add("button", undefined, "当前合成");
        var scanSelection = source.add("button", undefined, "项目选择");
        var scanAll = source.add("button", undefined, "整个项目");
        var ignore = source.add("checkbox", undefined, "忽略隐藏图层");

        var filter = win.add("group");
        filter.orientation = "row";
        filter.add("statictext", undefined, "搜索");
        var search = filter.add("edittext", undefined, "");
        search.characters = 22;
        var language = filter.add("dropdownlist", undefined, ["全部", "中文", "英文", "日文", "韩文", "其他"]);
        language.selection = 0;

        var list = win.add("listbox", undefined, [], { multiselect: true });
        list.minimumSize = [420, 220];
        list.preferredSize = [520, 300];

        var listActions = win.add("group");
        listActions.orientation = "row";
        var selectAll = listActions.add("button", undefined, "全选");
        var clearAll = listActions.add("button", undefined, "取消全选");
        var locate = listActions.add("button", undefined, "定位图层");

        var actions = win.add("panel", undefined, "批量操作");
        actions.orientation = "row";
        actions.alignChildren = ["left", "center"];
        var replace = actions.add("button", undefined, "整体替换");
        var findReplace = actions.add("button", undefined, "查找替换");
        var font = actions.add("button", undefined, "更换字体");
        var tracking = actions.add("button", undefined, "字间距");
        var leading = actions.add("button", undefined, "行距");

        var status = win.add("statictext", undefined, "请先扫描项目");
        status.characters = 62;

        function doScan(mode) {
            state.ignoreHidden = ignore.value;
            var result = scanProject(mode);
            refreshList(list, status);
            status.text = result.message + (state.failed ? "，异常项 " + state.failed : "");
        }

        scanActive.onClick = function () { doScan("active"); };
        scanSelection.onClick = function () { doScan("selection"); };
        scanAll.onClick = function () { doScan("all"); };
        ignore.onClick = function () { refreshList(list, status); };
        search.onChanging = function () {
            state.filterText = search.text;
            refreshList(list, status);
        };
        language.onChange = function () {
            state.language = language.selection ? language.selection.text : "全部";
            refreshList(list, status);
        };
        selectAll.onClick = function () {
            var i;
            for (i = 0; i < list.items.length; i++) { list.items[i].selected = true; }
        };
        clearAll.onClick = function () {
            var i;
            for (i = 0; i < list.items.length; i++) { list.items[i].selected = false; }
        };
        locate.onClick = function () {
            try {
                var rows = selectedRows(list);
                if (!rows.length) { throw new Error("请先选择一个文字图层"); }
                var comp = rows[0].comp;
                if (app.project.activeItem !== comp) { comp.openInViewer(); }
                rows[0].layer.selected = true;
                status.text = "已定位：" + rows[0].compName + " / " + rows[0].layerName;
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };
        replace.onClick = function () {
            var value = promptValue(SCRIPT_NAME, "将选中文字替换为：", "");
            if (value === null) { return; }
            try {
                var result = eachText(list, function (row) {
                    var doc = getTextDocument(row.layer);
                    doc.text = value;
                    setTextDocument(row.layer, doc);
                    row.text = value;
                });
                report(status, result, "整体替换");
                refreshList(list, status);
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };
        findReplace.onClick = function () {
            var find = promptValue(SCRIPT_NAME, "查找文字：", "");
            if (find === null || find === "") { return; }
            var to = promptValue(SCRIPT_NAME, "替换为：", "");
            if (to === null) { return; }
            try {
                var result = eachText(list, function (row) {
                    var doc = getTextDocument(row.layer);
                    doc.text = String(doc.text).split(find).join(to);
                    setTextDocument(row.layer, doc);
                    row.text = doc.text;
                });
                report(status, result, "查找替换");
                refreshList(list, status);
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };
        font.onClick = function () {
            var value = promptValue(SCRIPT_NAME, "字体 PostScript 名称：", "");
            if (value === null || trim(value) === "") { return; }
            try {
                var result = eachText(list, function (row) {
                    var doc = getTextDocument(row.layer);
                    doc.font = value;
                    setTextDocument(row.layer, doc);
                });
                report(status, result, "更换字体");
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };
        tracking.onClick = function () {
            var value = promptValue(SCRIPT_NAME, "字间距（tracking）：", "0");
            if (value === null || isNaN(Number(value))) { return; }
            try {
                var result = eachText(list, function (row) {
                    var doc = getTextDocument(row.layer);
                    doc.tracking = Number(value);
                    setTextDocument(row.layer, doc);
                });
                report(status, result, "字间距调整");
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };
        leading.onClick = function () {
            var value = promptValue(SCRIPT_NAME, "行距（leading）：", "0");
            if (value === null || isNaN(Number(value))) { return; }
            try {
                var result = eachText(list, function (row) {
                    var doc = getTextDocument(row.layer);
                    doc.leading = Number(value);
                    setTextDocument(row.layer, doc);
                });
                report(status, result, "行距调整");
            } catch (e) { alert(e.toString(), SCRIPT_NAME); }
        };

        win.onResizing = win.onResize = function () { this.layout.resize(); };
        if (win instanceof Window) { win.center(); win.show(); }
        return win;
    }

    buildUI(host);
})(this);
