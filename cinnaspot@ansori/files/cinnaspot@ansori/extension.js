const Extension = imports.ui.extension; 
const St = imports.gi.St; 
const Main = imports.ui.main; 
const Clutter = imports.gi.Clutter; 
const Settings = imports.ui.settings; 
const Util = imports.misc.util; 
const Meta = imports.gi.Meta; 
const Cinnamon = imports.gi.Cinnamon; 
const Mainloop = imports.mainloop; 
const Gio = imports.gi.Gio; 
const GLib = imports.gi.GLib;

class SpotlightExtension { 
    constructor(metadata) { 
        this.metadata = metadata; 
        this.isOpen = false; 
        this.resultItems = []; 
        this.sidebarItems = []; 
        this.selectedIndex = -1; 
        this.sidebarIndex = -1; 
        this.activePanel = 'main'; 
        this.searchTimeout = null; 
        this.isNavigating = false; 
        this.cachedApps = []; 
        this.searchSequence = 0;

        this.keybinding = "<Super>space";
        this.custom_placeholder = "Search apps, settings, commands, calc...";
        this.show_opened_windows = true;
        this.max_window_results = 5;
        this.max_results = 8;
        this.window_font_size = 11;
        
        this.show_system_info = false;
        this.disk_path = "/";
        
        this.theme = "dark";
        this.bg_opacity = 95;
        this.result_font_size = 14;
        this.enable_shutdown = true;
        this.enable_logout = true;
        this.thousand_separator = "comma";
        this.script_prefix = "sh";
        this.script_paths = "~/scripts";
        this.terminal_app = "x-terminal-emulator -e";

        this.settings = new Settings.ExtensionSettings(this, metadata.uuid);
        this.settings.bindProperty(Settings.BindingDirection.IN, "keybinding", "keybinding", this._setupKeybinding, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "custom_placeholder", "custom_placeholder", this._updatePlaceholder, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "show_opened_windows", "show_opened_windows", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "max_window_results", "max_window_results", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "max_results", "max_results", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "window_font_size", "window_font_size", this._triggerSearch, null);
        
        this.settings.bindProperty(Settings.BindingDirection.IN, "show_system_info", "show_system_info", this._toggleSysInfoPanel.bind(this), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "disk_path", "disk_path", null, null);

        this.settings.bindProperty(Settings.BindingDirection.IN, "theme", "theme", this._applyTheme, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg_opacity", "bg_opacity", this._applyTheme, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "result_font_size", "result_font_size", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "enable_shutdown", "enable_shutdown", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "enable_logout", "enable_logout", this._triggerSearch, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "thousand_separator", "thousand_separator", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "script_prefix", "script_prefix", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "script_paths", "script_paths", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "terminal_app", "terminal_app", null, null);

        this.lastCpu = null;
        this.sysInfoTimeout = null;
    }

    enable() {
        this._setupKeybinding();
        this._createUI();
        this._cacheApplications();
    }

    disable() {
        if (this.searchTimeout) {
            try { Mainloop.source_remove(this.searchTimeout); } catch(e) {}
            this.searchTimeout = null;
        }

        this._stopSysInfoLoop();

        if (this.textChangedId && this.searchEntry) {
            this.searchEntry.clutter_text.disconnect(this.textChangedId);
            this.textChangedId = null;
        }

        if (this.keyPressId && this.searchEntry) {
            this.searchEntry.clutter_text.disconnect(this.keyPressId);
            this.keyPressId = null;
        }

        if (this.keybindingId) Main.keybindingManager.removeHotKey(this.keybindingId);
        
        if (this.isOpen) {
            try { Main.popModal(this.mainContainer); } catch(e) {}
            try { Main.popModal(this.sidebarContainer); } catch(e) {}
            try { Main.popModal(this.sysInfoContainer); } catch(e) {}
        }

        if (this.mainContainer) { this.mainContainer.destroy(); this.mainContainer = null; }
        if (this.sidebarContainer) { this.sidebarContainer.destroy(); this.sidebarContainer = null; }
        if (this.sysInfoContainer) { this.sysInfoContainer.destroy(); this.sysInfoContainer = null; }
    }

    _cacheApplications() {
        try {
            this.cachedApps = Gio.AppInfo.get_all().filter(app => {
                try {
                    let name = app.get_name() ? app.get_name().toLowerCase() : "";
                    let isTerminalSys = name.includes('terminal') || name.includes('console');
                    return app.should_show() || isTerminalSys;
                } catch(e) {
                    return app.should_show();
                }
            });
        } catch(e) {
            this.cachedApps = [];
        }
    }

    _setupKeybinding() {
        if (this.keybindingId) Main.keybindingManager.removeHotKey(this.keybindingId);
        this.keybindingId = Main.keybindingManager.addHotKey(this.metadata.uuid, this.keybinding, () => this._toggleSpotlight());
    }

    _updatePlaceholder() {
        if (this.searchEntry) this.searchEntry.set_hint_text(this.custom_placeholder);
    }

    _formatNumber(num) {
        let parts = Number(num).toFixed(6).replace(/\.?0+$/, "").split('.');
        let integerPart = parts[0];
        let decimalPart = parts[1] || '';

        let thousandSep = (this.thousand_separator === 'dot') ? '.' : ',';
        let decimalSep = (this.thousand_separator === 'dot') ? ',' : '.';

        integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandSep);

        return decimalPart ? `${integerPart}${decimalSep}${decimalPart}` : integerPart;
    }

    _confirmAndExecute(title, message, command) {
        this._toggleSpotlight();
        
        // read -rsn1 membaca 1 karakter tanpa Enter dan secara diam-diam (silent)
        // -z "$ans" menangkap input tombol [Enter] karena string bernilai kosong
        const promptScript = `
            echo -e "\\e[1;36m  [ ${title.toUpperCase()} ] \\e[0m"
            echo -e "\\e[1;36m\\e[0m                                                          \\e[0m"
            echo -e "\\e[1;36m\\e[0m  \\e[1;33m⚠  ${message}\\e[0m"
            echo -e "\\e[1;36m\\e[0m                                                          \\e[0m"
            echo
            echo -e "  \\e[1;32mENTER / Y\\e[0m  →  confirm"
            echo -e "  \\e[1;31mESC   / N\\e[0m  →  cancel"
            echo
            echo -ne "  \\e[1;36m❯\\e[0m "

            read -r -s -n 1 ans

            if [[ "$ans" == "y" || "$ans" == "Y" || -z "$ans" ]]; then
                ${command}
            fi
            `;
        try {
            let terminalCmds = this.terminal_app.split(' ').map(c => c.trim()).filter(c => c.length > 0);
            let argv = terminalCmds.concat(['bash', '-c', promptScript]);
            Util.spawn(argv);
        } catch(e) {}
    }

    _getThemeColors() {
        let op = this.bg_opacity / 100.0;
        
        if (this.theme === 'light') {
            return {
                mainBg: `rgba(255, 255, 255, ${op})`,
                searchBg: `rgba(241, 245, 249, ${Math.min(1, op + 0.15)})`,
                border: `rgba(0, 0, 0, 0.1)`,
                textPrimary: '#0f172a',
                textSecondary: '#64748b',
                sidebarBg: `rgba(248, 250, 252, ${op})`,
                sidebarItemBg: `rgba(255, 255, 255, ${Math.min(1, op + 0.1)})`,
                highlight: '#2563eb', 
                selectedText: '#ffffff',
                selectedSubText: '#bfdbfe', 
                entrySelectionBg: '#93c5fd',
                entrySelectionColor: '#0f172a',
                shadow: `rgba(0, 0, 0, 0.1)`,
                trackBg: `rgba(0, 0, 0, 0.1)` 
            };
        } else {
            return {
                mainBg: `rgba(19, 23, 32, ${op})`,
                searchBg: `rgba(26, 32, 44, ${Math.min(1, op + 0.15)})`,
                border: `rgba(255,255,255, 0.08)`,
                textPrimary: '#f8fafc',
                textSecondary: '#94a3b8',
                sidebarBg: `rgba(19, 23, 32, ${op})`,
                sidebarItemBg: `rgba(26, 32, 44, ${Math.min(1, op + 0.1)})`,
                highlight: '#2563eb',
                selectedText: '#ffffff',
                selectedSubText: '#bfdbfe',
                entrySelectionBg: '#3b82f6',
                entrySelectionColor: '#ffffff',
                shadow: `rgba(0, 0, 0, 0.7)`,
                trackBg: `rgba(255, 255, 255, 0.1)` 
            };
        }
    }

    _applyTheme() {
        if (!this.mainContainer) return;
        let colors = this._getThemeColors();
        
        this.spotlightBox.set_style(`width: 720px; background-color: ${colors.mainBg}; border-radius: 16px; padding: 18px; border: 1px solid ${colors.border}; box-shadow: 0px 15px 40px ${colors.shadow};`);
        this.searchBarBox.set_style(`background-color: ${colors.searchBg}; border-radius: 10px; padding: 12px 16px; border: 1px solid ${colors.border};`);
        this.searchIcon.set_style(`color: ${colors.textSecondary}; margin-right: 12px;`);
        
        this.searchEntry.set_style(`font-size: 18px; background-color: transparent; color: ${colors.textPrimary}; border: none; padding: 0px; selection-background-color: ${colors.entrySelectionBg}; selected-color: ${colors.entrySelectionColor};`);
        
        if (this.clearIcon) this.clearIcon.set_style(`color: ${colors.textSecondary};`);
        this.hintLabel.set_style(`color: ${colors.textSecondary}; font-size: 11px; text-align: center; padding-top: 10px;`);
        
        this.sidebarBox.set_style(`width: 360px; background-color: ${colors.sidebarBg}; border-radius: 0px 16px 16px 0px; padding: 16px; border-right: 1px solid ${colors.border}; box-shadow: 10px 0px 30px ${colors.shadow};`);
        this.sidebarTitle.set_style(`color: ${colors.textSecondary}; font-size: 14px; font-weight: bold; margin-bottom: 12px; padding-left: 4px;`);

        // FIX PRESISI LEBAR: 312px (konten) + 24px (padding kiri) + 24px (padding kanan) = Total 360px.
        if (this.sysInfoBox) {
            this.sysInfoBox.set_style(`width: 312px; background-color: ${colors.sidebarBg}; border-radius: 16px 0px 0px 16px; padding: 24px; border-left: 1px solid ${colors.border}; box-shadow: -10px 0px 30px ${colors.shadow};`);
        }
        if (this.sysInfoTitle) {
            this.sysInfoTitle.set_style(`color: ${colors.textSecondary}; font-size: 14px; font-weight: bold; margin-bottom: 24px; padding-left: 4px;`);
        }
        
        if (this.cpuTrack) this.cpuTrack.set_style(`background-color: ${colors.trackBg}; border-radius: 4px; height: 6px; width: 312px;`);
        if (this.ramTrack) this.ramTrack.set_style(`background-color: ${colors.trackBg}; border-radius: 4px; height: 6px; width: 312px;`);
        if (this.swapTrack) this.swapTrack.set_style(`background-color: ${colors.trackBg}; border-radius: 4px; height: 6px; width: 312px;`);
        if (this.diskTrack) this.diskTrack.set_style(`background-color: ${colors.trackBg}; border-radius: 4px; height: 6px; width: 312px;`);

        if (this.isOpen) {
            this._triggerSearch();
        }
    }

    _createMetricWidget(iconName, title, accentColor) {
        let container = new St.BoxLayout({ vertical: true, style: 'margin-bottom: 24px;' });
        
        let headerBox = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 8px;' });
        let icon = new St.Icon({ icon_name: iconName, icon_size: 14, style: `color: ${accentColor}; margin-right: 8px; margin-top: 2px;` });
        let titleLabel = new St.Label({ text: title, style: 'color: #94a3b8; font-size: 13px; font-weight: bold;' });
        
        let spacer = new St.Widget({ x_expand: true });
        
        let valueLabel = new St.Label({ text: "-", style: `color: ${accentColor}; font-size: 13px; font-weight: bold; font-family: monospace; text-shadow: 0px 0px 5px rgba(0,0,0,0.3);` });

        headerBox.add_child(icon);
        headerBox.add_child(titleLabel);
        headerBox.add_child(spacer);
        headerBox.add_child(valueLabel);

        // Track bar disamakan persis dengan lebar konten box (312px)
        let track = new St.BoxLayout({ vertical: false, style: 'background-color: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; width: 312px;' });
        let bar = new St.Widget({ style: `background-color: ${accentColor}; border-radius: 4px; height: 6px; box-shadow: 0px 0px 8px ${accentColor};` });
        bar.set_width(0);
        track.add_child(bar);

        container.add_child(headerBox);
        container.add_child(track);

        return {
            container, track, bar, valueLabel,
            setProgress: (usage, text) => {
                let percent = Math.max(0, Math.min(1, usage));
                bar.set_width(percent * 312); // Lebar bar maksimal 312px
                valueLabel.set_text(text);
            }
        };
    }

    _createUI() {
        this.mainContainer = new St.Widget({
            visible: false, reactive: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height,
            style: 'background-color: rgba(0,0,0,0.6);'
        });

        this.spotlightBox = new St.BoxLayout({ vertical: true });
        this.searchBarBox = new St.BoxLayout({ vertical: false });
        
        this.searchIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 18
        });

        this.searchEntry = new St.Entry({
            hint_text: this.custom_placeholder, track_hover: true, can_focus: true,
            x_expand: true
        });

        this.clearButton = new St.Button({
            reactive: true, can_focus: true, track_hover: true, visible: false,
            style: 'padding: 0px 4px; background-color: transparent; margin-left: 8px;'
        });

        this.clearIcon = new St.Icon({
            icon_name: 'edit-clear-symbolic', icon_size: 16
        });
        this.clearButton.set_child(this.clearIcon);

        this.clearButton.connect('clicked', () => {
            this.searchEntry.set_text('');
            global.stage.set_key_focus(this.searchEntry);
        });

        this.searchBarBox.add_child(this.searchIcon);
        this.searchBarBox.add_child(this.searchEntry);
        this.searchBarBox.add_child(this.clearButton);

        this.textChangedId = this.searchEntry.clutter_text.connect('text-changed', () => {
            let text = this.searchEntry.get_text();
            if (this.clearButton) {
                this.clearButton.visible = (text.length > 0);
            }

            if (this.isNavigating) return;
            if (this.searchTimeout) {
                try { Mainloop.source_remove(this.searchTimeout); } catch(e) {}
                this.searchTimeout = null;
            }
            this.searchTimeout = Mainloop.timeout_add(250, () => {
                this.searchTimeout = null;
                this._onSearchChange();
                return false;
            });
        });
        
        this.keyPressId = this.searchEntry.clutter_text.connect('key-press-event', this._onKeyPress.bind(this));

        this.scrollView = new St.ScrollView({ style: 'padding-top: 0px; max-height: 420px;' });
        this.scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this.scrollView.add_actor(this.resultsBox);

        this.hintLabel = new St.Label({ text: "" });

        this.spotlightBox.add_child(this.searchBarBox);
        this.spotlightBox.add_child(this.scrollView);
        this.spotlightBox.add_child(this.hintLabel);
        this.mainContainer.add_child(this.spotlightBox);
        
        //this.spotlightBox.set_position((global.stage.width - 720) / 2, global.stage.height * 0.18);
        this.spotlightBox.set_position((global.stage.width - 720) / 2, (global.stage.height - (global.stage.height * 0.75)) / 2);
        Main.uiGroup.add_actor(this.mainContainer);

        // Sidebar Kiri (Opened Windows)
        this.sidebarContainer = new St.Widget({
            visible: false, reactive: false, x: 0, y: 0,
            width: 250, height: global.stage.height
        });

        this.sidebarBox = new St.BoxLayout({ vertical: true });
        this.sidebarTitle = new St.Label({ text: "Opened Windows" });
        this.sidebarBox.add_child(this.sidebarTitle);

        this.sidebarScroll = new St.ScrollView({ style: 'max-height: ' + (global.stage.height * 0.85) + 'px;' });
        this.sidebarScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.sidebarResultsBox = new St.BoxLayout({ vertical: true });
        this.sidebarScroll.add_actor(this.sidebarResultsBox);
        this.sidebarBox.add_child(this.sidebarScroll);

        this.sidebarContainer.add_child(this.sidebarBox);
        this.sidebarBox.set_position(0, (global.stage.height - (global.stage.height * 0.85)) / 2);
        Main.uiGroup.add_actor(this.sidebarContainer);

        // Sidebar Kanan (System Info) - Container dilebarkan menjadi total 360px
        this.sysInfoContainer = new St.Widget({
            visible: false, reactive: false, x: 0, y: 0,
            width: 360, height: global.stage.height
        });

        this.sysInfoBox = new St.BoxLayout({ vertical: true });
        this.sysInfoTitle = new St.Label({ text: "System Info" });
        this.sysInfoBox.add_child(this.sysInfoTitle);

        let cpuMetric = this._createMetricWidget("gnome-cpu-frequency-applet", "CPU Usage", "#f43f5e");
        let ramMetric = this._createMetricWidget("gnome-dev-memory", "RAM Usage", "#3b82f6"); 
        let swapMetric = this._createMetricWidget("system-run-symbolic", "Swap Usage", "#a855f7"); 
        let diskMetric = this._createMetricWidget("drive-harddisk-symbolic", "Disk Usage", "#10b981");

        this.cpuMetricAPI = cpuMetric;
        this.ramMetricAPI = ramMetric;
        this.swapMetricAPI = swapMetric;
        this.diskMetricAPI = diskMetric;

        this.cpuTrack = cpuMetric.track;
        this.ramTrack = ramMetric.track;
        this.swapTrack = swapMetric.track;
        this.diskTrack = diskMetric.track;

        this.sysInfoBox.add_child(cpuMetric.container);
        this.sysInfoBox.add_child(ramMetric.container);
        this.sysInfoBox.add_child(swapMetric.container);
        this.sysInfoBox.add_child(diskMetric.container);

        this.sysInfoContainer.add_child(this.sysInfoBox);
        
        // Container di-set persis di tepi kanan layar
        this.sysInfoContainer.set_position(global.stage.width - 360, 0); 
        this.sysInfoBox.set_position(0, (global.stage.height - (global.stage.height * 0.85)) / 2);
        
        Main.uiGroup.add_actor(this.sysInfoContainer);

        this._applyTheme();
    }

    _toggleSysInfoPanel() {
        if (this.sysInfoContainer) {
            let shouldShow = this.isOpen && this.show_system_info;
            this.sysInfoContainer.visible = shouldShow;
            
            if (shouldShow) {
                this._startSysInfoLoop();
            } else {
                this._stopSysInfoLoop();
            }
        }
    }

    _startSysInfoLoop() {
        this._stopSysInfoLoop();
        this._updateSysInfoMetrics(); 
        
        this.sysInfoTimeout = Mainloop.timeout_add_seconds(2, () => {
            this._updateSysInfoMetrics();
            return true; 
        });
    }

    _stopSysInfoLoop() {
        if (this.sysInfoTimeout) {
            Mainloop.source_remove(this.sysInfoTimeout);
            this.sysInfoTimeout = null;
        }
    }

    _updateSysInfoMetrics() {
        if (!this.isOpen || !this.show_system_info) return;

        // CPU Usage
        try {
            let [success, contents] = GLib.file_get_contents("/proc/stat");
            if (success) {
                let lines = contents.toString().split('\n');
                let cpuLine = lines[0].match(/cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
                if (cpuLine) {
                    let user = parseInt(cpuLine[1]);
                    let nice = parseInt(cpuLine[2]);
                    let system = parseInt(cpuLine[3]);
                    let idle = parseInt(cpuLine[4]);
                    let total = user + nice + system + idle;
                    
                    if (this.lastCpu) {
                        let totalDiff = total - this.lastCpu.total;
                        let idleDiff = idle - this.lastCpu.idle;
                        let usage = totalDiff > 0 ? (totalDiff - idleDiff) / totalDiff : 0;
                        this.cpuMetricAPI.setProgress(usage, `${(usage * 100).toFixed(1)}%`);
                    }
                    this.lastCpu = { total, idle };
                }
            }
        } catch (e) {}

        // RAM & Swap Usage
        try {
            let [success, contents] = GLib.file_get_contents("/proc/meminfo");
            if (success) {
                let lines = contents.toString().split('\n');
                let memTotal = 0, memAvailable = 0, swapTotal = 0, swapFree = 0;
                
                lines.forEach(line => {
                    if (line.startsWith("MemTotal:")) memTotal = parseInt(line.match(/\d+/)[0]);
                    if (line.startsWith("MemAvailable:")) memAvailable = parseInt(line.match(/\d+/)[0]);
                    if (line.startsWith("SwapTotal:")) swapTotal = parseInt(line.match(/\d+/)[0]);
                    if (line.startsWith("SwapFree:")) swapFree = parseInt(line.match(/\d+/)[0]);
                });
                
                let ramUsage = memTotal > 0 ? (memTotal - memAvailable) / memTotal : 0;
                let ramUsedGB = (memTotal - memAvailable) / 1024 / 1024;
                let ramTotalGB = memTotal / 1024 / 1024;
                this.ramMetricAPI.setProgress(ramUsage, `${ramUsedGB.toFixed(1)}GB / ${ramTotalGB.toFixed(1)}GB`);

                let swapUsage = swapTotal > 0 ? (swapTotal - swapFree) / swapTotal : 0;
                if (swapTotal > 0) {
                    let swapUsedGB = (swapTotal - swapFree) / 1024 / 1024;
                    let swapTotalGB = swapTotal / 1024 / 1024;
                    this.swapMetricAPI.setProgress(swapUsage, `${swapUsedGB.toFixed(1)}GB / ${swapTotalGB.toFixed(1)}GB`);
                } else {
                    this.swapMetricAPI.setProgress(0, "0.0GB / 0.0GB");
                }
            }
        } catch (e) {}

        // Disk Usage
        try {
            let targetPath = this.disk_path && this.disk_path.trim() !== "" ? this.disk_path : "/";
            let file = Gio.File.new_for_path(targetPath);
            let info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
            
            let size = info.get_attribute_uint64('filesystem::size');
            let free = info.get_attribute_uint64('filesystem::free');
            let used = size - free;
            let usage = size > 0 ? used / size : 0;
            
            let diskUsedGB = used / 1073741824;
            let diskTotalGB = size / 1073741824;
            
            this.diskMetricAPI.setProgress(usage, `${diskUsedGB.toFixed(1)}GB / ${diskTotalGB.toFixed(1)}GB`);
        } catch (e) {
            this.diskMetricAPI.setProgress(0, "N/A");
        }
    }

    _getActiveMonitorGeometry() {
        try {
            // Use Cinnamon's global pointer for screen-space coordinates
            let [cx, cy] = global.get_pointer();
            let n = global.screen.get_n_monitors();

            for (let i = 0; i < n; i++) {
                let g = global.screen.get_monitor_geometry(i);
                if (cx >= g.x && cx < g.x + g.width && cy >= g.y && cy < g.y + g.height) {
                    return { x: g.x, y: g.y, width: g.width, height: g.height };
                }
            }

            // Fallback to primary monitor
            let primary = null;
            if (typeof global.screen.get_primary_monitor === 'function') {
                primary = global.screen.get_primary_monitor();
            }
            if (primary !== null && primary !== undefined) {
                let g = global.screen.get_monitor_geometry(primary);
                return { x: g.x, y: g.y, width: g.width, height: g.height };
            }

            // Fallback to monitor 0
            let g0 = global.screen.get_monitor_geometry(0);
            return { x: g0.x, y: g0.y, width: g0.width, height: g0.height };
        } catch (e) {}
        return { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
    }

    _positionUI(monitor) {
        // Center spotlight on the active monitor
        this.spotlightBox.set_position(
            monitor.x + Math.round((monitor.width - 720) / 2),
            monitor.y + Math.round((monitor.height - (monitor.height * 0.75)) / 2)
        );

        // Position opened-windows sidebar on the left side of the active monitor
        if (this.sidebarContainer) {
            this.sidebarContainer.set_position(monitor.x, monitor.y);
            this.sidebarBox.set_position(0, Math.round((monitor.height - (monitor.height * 0.85)) / 2));
        }

        // Position system-info sidebar on the right side of the active monitor
        if (this.sysInfoContainer) {
            this.sysInfoContainer.set_position(monitor.x + monitor.width - 360, monitor.y);
            this.sysInfoBox.set_position(0, Math.round((monitor.height - (monitor.height * 0.85)) / 2));
        }
    }

    _toggleSpotlight() {
        this.isOpen = !this.isOpen;

        if (this.isOpen) {
            // Position UI on the monitor where the cursor currently is
            let monitor = this._getActiveMonitorGeometry();
            this._positionUI(monitor);
        }

        if (this.mainContainer) this.mainContainer.visible = this.isOpen;
        if (this.sidebarContainer) this.sidebarContainer.visible = this.isOpen && this.show_opened_windows;

        this._toggleSysInfoPanel();

        if (this.isOpen) {
            this.activePanel = 'main';
            this._cacheApplications();
            Main.pushModal(this.mainContainer);
            global.stage.set_key_focus(this.searchEntry);
            this._triggerSearch();
        } else {
            Main.popModal(this.mainContainer);
            if (this.searchEntry) this.searchEntry.set_text('');
            if (this.clearButton) this.clearButton.visible = false;
            if (this.resultsBox) this.resultsBox.destroy_all_children();
            if (this.sidebarResultsBox) this.sidebarResultsBox.destroy_all_children();
            if (this.hintLabel) this.hintLabel.set_text('');
            if (this.scrollView) this.scrollView.style = 'padding-top: 0px; max-height: 420px;';
        }
    }

    _triggerSearch() {
        this._onSearchChange();
    }

    async _onSearchChange() {
        if (!this.isOpen || !this.searchEntry) return;

        this.searchSequence++;
        let currentSearchId = this.searchSequence;

        let query = this.searchEntry.get_text().toLowerCase().trim();
        this.resultsBox.destroy_all_children();
        this.resultItems = [];
        this.selectedIndex = -1;

        this._updateSidebarWindows(query);

        if (query === "") {
            if (this.scrollView) this.scrollView.style = 'padding-top: 0px; max-height: 420px;';
            if (this.hintLabel) this.hintLabel.set_text('');
            return;
        }

        if (this.scrollView) this.scrollView.style = 'padding-top: 12px; max-height: 420px;';

        try {
            let prefixWithSpace = this.script_prefix.toLowerCase() + " ";
            if (query.startsWith(prefixWithSpace) || query === this.script_prefix.toLowerCase()) {
                let scriptQuery = query.startsWith(prefixWithSpace) ? query.substring(prefixWithSpace.length).trim() : "";
                await this._showScriptResults(scriptQuery);
                if (currentSearchId !== this.searchSequence) return; 
                return; 
            }
        } catch(e) {}

        try {
            let isMath = /^[0-9+\-*\/\(\)\.\s]+$/.test(query);
            let hasOperator = /[+\-*\/]/.test(query);
            let validEnd = /[0-9\)]$/.test(query);
            
            if (isMath && hasOperator && validEnd) {
                let mathQuery = query.replace(/[^\d+\-*/().]/g, '');
                let rawResult = Function(`"use strict"; return (${mathQuery})`)();
                
                if (rawResult !== undefined && !isNaN(rawResult)) {
                    let formattedExpr = query
                    .replace(/\*/g, ' × ')
                    .replace(/\//g, ' : ')
                    .replace(/\d+(\.\d+)?/g, (match) => this._formatNumber(match));

                    let formattedResult = this._formatNumber(rawResult);

                    this._addCalculatorHeroCard(formattedExpr, formattedResult, rawResult.toString());
                }
            }
        } catch(e) {}

        try {
            let sessionCommands = [];
            if (this.enable_shutdown) {
                sessionCommands.push(
                    { name: "Shutdown", icon: "system-shutdown-symbolic", cmd: "systemctl poweroff", desc: "Power off the computer", title: "Shutdown", msg: "Are you sure you want to shut down the computer?" },
                    { name: "Restart", icon: "view-refresh-symbolic", cmd: "systemctl reboot", desc: "Reboot the computer", title: "Restart", msg: "Are you sure you want to restart the computer?" },
                    { name: "Suspend", icon: "media-playback-pause-symbolic", cmd: "systemctl suspend", desc: "Suspend the computer", title: "Suspend", msg: "Are you sure you want to suspend the computer?" }
                );
            }
            if (this.enable_logout) {
                sessionCommands.push(
                    { name: "Logout", icon: "system-log-out-symbolic", cmd: "cinnamon-session-quit --logout", desc: "Log out of the session", title: "Logout", msg: "Are you sure you want to log out?" },
                    { name: "Lock Screen", icon: "system-lock-screen-symbolic", cmd: "cinnamon-screensaver-command --lock", desc: "Lock the current session", title: "Lock Screen", msg: "Are you sure you want to lock the screen?" },
                    { name: "Switch User", icon: "system-users-symbolic", cmd: "dm-tool switch-to-greeter", desc: "Switch to another user account", title: "Switch User", msg: "Are you sure you want to switch user?" }
                );
            }

            let cmdMatches = sessionCommands.filter(c => 
                c.name.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query)
            );

            cmdMatches.forEach(c => {
                this._addResultItem(
                    c.icon,
                    c.name,
                    "System Action • " + c.desc,
                    () => this._confirmAndExecute(c.title, c.msg, c.cmd),
                    '#ef4444'
                );
            });
        } catch(e) {}

        try {
            let queryLower = query.toLowerCase();
            let scoredApps = this.cachedApps.map(app => {
                let name = app.get_name() ? app.get_name().toLowerCase() : "";
                let exec = app.get_executable() ? app.get_executable().toLowerCase() : "";
                let desc = app.get_description() ? app.get_description().toLowerCase() : "";
                let keywords = "";

                try {
                    if (typeof app.get_keywords === 'function' && app.get_keywords()) {
                        keywords = app.get_keywords().join(' ').toLowerCase();
                    }
                } catch(e) {}

                let score = -1;
                let nameLower = name.toLowerCase();

                if (nameLower.includes('preferences') || nameLower.includes('settings') || nameLower.includes('help')) {
                    score = 5;
                } else if (name === queryLower) {
                    score = 0;
                } else if (name.startsWith(queryLower)) {
                    score = 1;
                } else if (name.includes(queryLower)) {
                    score = 2;
                } else if (exec.includes(queryLower) || keywords.includes(queryLower)) {
                    score = 3;
                } else if (desc.includes(queryLower)) {
                    score = 4;
                }

                return { app, score };
            });

            let appMatches = scoredApps
                .filter(item => item.score !== -1)
                .sort((a, b) => a.score - b.score)
                .map(item => item.app)
                .slice(0, Number(this.max_results) || 8);

            appMatches.forEach(app => {
                let appIcon = 'application-default-icon';
                try {
                    appIcon = app.get_icon() || 'application-default-icon';
                } catch(e) {}
                
                this._addResultItem(
                    appIcon, 
                    app.get_name(), 
                    "Application",
                    () => {
                        try { app.launch([], null); } catch(e){}
                        this._toggleSpotlight();
                    },
                    'default'
                );
            });
        } catch(e) {}

        if (this.resultItems.length > 0) {
            if (this.activePanel === 'main') {
                this._setSelectedIndex(0);
            }
        }

        if (this.sidebarItems.length > 0 && this.resultItems.length > 0) {
            this.hintLabel.set_text("Press [Tab] to switch between Windows and Search results • [↑/↓] Navigate • [Enter] Select");
        } else {
            this.hintLabel.set_text("[↑/↓] Navigate • [Enter] Select");
        }
    }

    _updateSidebarWindows(query) {
        if (!this.sidebarResultsBox) return;
        this.sidebarResultsBox.destroy_all_children();
        this.sidebarItems = [];
        this.sidebarIndex = -1;

        if (!this.show_opened_windows) {
            if (this.sidebarContainer) this.sidebarContainer.visible = false;
            return;
        }

        try {
            let windows = [];
            let screen = global.workspace_manager || global.screen;
            let activeWorkspaceIndex = -1;

            if (screen) {
                activeWorkspaceIndex = screen.get_active_workspace_index();
                let n_workspaces = screen.get_n_workspaces();
                for (let i = 0; i < n_workspaces; i++) {
                    if (!query && i !== activeWorkspaceIndex) continue;
                    let ws = screen.get_workspace_by_index(i);
                    windows.push(...ws.list_windows());
                }
            }

            let windowMatches = windows.filter(w => {
                if (w.is_skip_taskbar && w.is_skip_taskbar()) return false;
                if (!query) return true;
                let title = w.get_title() ? w.get_title().toLowerCase() : "";
                let appClass = w.get_wm_class() ? w.get_wm_class().toLowerCase() : "";
                return title.includes(query) || appClass.includes(query);
            });

            if (query && activeWorkspaceIndex !== -1) {
                windowMatches.sort((a, b) => {
                    let aWsIndex = a.get_workspace ? a.get_workspace().index() : -1;
                    let bWsIndex = b.get_workspace ? b.get_workspace().index() : -1;
                    let aIsActive = (aWsIndex === activeWorkspaceIndex) ? 0 : 1;
                    let bIsActive = (bWsIndex === activeWorkspaceIndex) ? 0 : 1;
                    return aIsActive - bIsActive;
                });
            }

            windowMatches = windowMatches.slice(0, this.max_window_results);

            if (windowMatches.length === 0) {
                if (this.sidebarContainer) this.sidebarContainer.visible = false;
                return;
            }

            if (this.sidebarContainer && this.isOpen) {
                this.sidebarContainer.visible = true;
            }

            windowMatches.forEach(w => {
                let wsIndex = (w.get_workspace ? w.get_workspace().index() : 0) + 1;
                let metaWindow = w.get_compositor_private();

                this._addSidebarThumbnailItem(metaWindow, w.get_title() || "Unknown Window", `Workspace ${wsIndex}`, () => this._activateWindow(w));
            });

            if (this.sidebarItems.length > 0 && this.activePanel === 'sidebar') {
                this._setSidebarIndex(0);
            }
        } catch(e) {
            if (this.sidebarContainer) this.sidebarContainer.visible = false;
        }
    }

    _addSidebarThumbnailItem(metaWindow, title, subtitle, actionFunc) {
        let colors = this._getThemeColors();
        let itemBox = new St.BoxLayout({
            vertical: true, reactive: true, track_hover: true,
            style: `padding: 8px; border-radius: 8px; margin-bottom: 8px; background-color: ${colors.sidebarItemBg};`
        });

        let targetWidth = 198; 
        let maxHeight = 130; 
        
        let originalWidth = targetWidth;
        let originalHeight = maxHeight;

        if (metaWindow) {
            try {
                let win = metaWindow.meta_window;
                if (win && typeof win.get_frame_rect === 'function') {
                    let rect = win.get_frame_rect();
                    originalWidth = rect.width;
                    originalHeight = rect.height;
                } else if (typeof metaWindow.get_size === 'function') {
                    [originalWidth, originalHeight] = metaWindow.get_size();
                }
            } catch(e) {}
        }

        // Hitung ukuran akhir yang proporsional
        let finalW = targetWidth;
        let finalH = maxHeight;
        
        if (originalWidth > 0 && originalHeight > 0) {
            // Hitung skala untuk lebar dan tinggi secara terpisah
            let scaleW = targetWidth / originalWidth;
            let scaleH = maxHeight / originalHeight;
            
            // Gunakan skala yang paling KECIL agar seluruh jendela muat (fit/contain)
            let scale = Math.min(scaleW, scaleH);
            
            finalW = Math.round(originalWidth * scale);
            finalH = Math.round(originalHeight * scale);
        }

        // Container lebarnya selalu tetap (198px), tingginya dinamis sesuai gambar (maksimal 130px)
        let thumbContainer = new St.Bin({
            width: targetWidth, 
            height: finalH, 
            x_align: St.Align.MIDDLE, // Jika gambar lebih sempit dari 198px, letakkan di tengah
            y_align: St.Align.MIDDLE, 
            style: `width: \({targetWidth}px; height:\){finalH}px; background-color: #000000; border-radius: 6px; overflow: hidden; margin-bottom: 6px;`
        });

        if (metaWindow) {
            try {
                let clone = new Clutter.Clone({ source: metaWindow });
                
                // Kunci Utama: Tetapkan ukuran clone langsung ke perhitungan proporsional kita
                clone.set_size(finalW, finalH);

                thumbContainer.set_child(clone); 

                let unmanagedId = metaWindow.connect('unmanaged', () => {
                    if (clone) clone.destroy();
                    if (itemBox) itemBox.destroy();
                });

                itemBox.connect('destroy', () => {
                    if (metaWindow && unmanagedId) {
                        try { metaWindow.disconnect(unmanagedId); } catch(e) {}
                    }
                });
            } catch(e) {}
        }

        let textBox = new St.BoxLayout({ vertical: true });
        let titleLabel = new St.Label({ text: title, style: `font-weight: bold; color: ${colors.textPrimary}; font-size: ${this.window_font_size}px;` });
        let subLabel = new St.Label({ text: subtitle, style: `color: ${colors.textSecondary}; font-size: ${Math.max(8, this.window_font_size - 2)}px; margin-top: 2px;` });
        
        textBox.add_child(titleLabel);
        textBox.add_child(subLabel);

        itemBox.add_child(thumbContainer);
        itemBox.add_child(textBox);

        itemBox.titleLabel = titleLabel;
        itemBox.subLabel = subLabel;

        itemBox.actionFunc = actionFunc;
        itemBox.connect('button-press-event', () => { actionFunc(); return Clutter.EVENT_STOP; });

        this.sidebarResultsBox.add_child(itemBox);
        this.sidebarItems.push(itemBox);
    }

    _addCalculatorHeroCard(expression, displayResult, rawResult) {
        let colors = this._getThemeColors();
        let heroBox = new St.BoxLayout({
            vertical: true,
            style: `background-color: ${colors.searchBg}; border-radius: 12px; padding: 20px; margin-bottom: 12px; border: 1px solid ${colors.border};`
        });

        let exprLabel = new St.Label({
            text: expression,
            style: `color: ${colors.textSecondary}; font-size: 14px; text-align: center;`
        });

        let resLabel = new St.Label({
            text: displayResult,
            style: `color: ${colors.textPrimary}; font-size: 32px; font-weight: bold; text-align: center; padding: 8px 0px;`
        });

        let copyHintBox = new St.BoxLayout({
            vertical: false, style: 'text-align: center; width: 100%;'
        });
        
        let copyIcon = new St.Icon({
            icon_name: 'edit-copy-symbolic', icon_size: 14, style: 'color: #38bdf8; margin-right: 6px;'
        });

        let hintLabel = new St.Label({
            text: "Copy Result", style: 'color: #38bdf8; font-size: 13px;'
        });

        copyHintBox.add_child(copyIcon);
        copyHintBox.add_child(hintLabel);

        heroBox.add_child(exprLabel);
        heroBox.add_child(resLabel);
        heroBox.add_child(copyHintBox);

        let actionFunc = () => this._copyToClipboard(rawResult);
        heroBox.actionFunc = actionFunc;
        heroBox.reactive = true;
        heroBox.track_hover = true;
        heroBox.connect('button-press-event', () => { actionFunc(); return Clutter.EVENT_STOP; });

        this.resultsBox.add_child(heroBox);
        this.resultItems.push(heroBox);
    }

    _addResultItem(iconSource, title, subtitle, actionFunc, titleColor = 'default') {
        let colors = this._getThemeColors();
        let appliedTitleColor = titleColor === 'default' ? colors.textPrimary : titleColor;

        let itemBox = new St.BoxLayout({
            vertical: false, reactive: true, track_hover: true,
            style: 'padding: 12px 14px; border-radius: 8px; margin-bottom: 4px; background-color: transparent;'
        });

        let icon;
        if (typeof iconSource === 'object' && iconSource !== null) {
            icon = new St.Icon({ gicon: iconSource, icon_size: 24, style: 'margin-right: 14px;' });
        } else {
            icon = new St.Icon({ icon_name: iconSource || 'application-default-icon', icon_size: 24, icon_type: St.IconType.FULLCOLOR, style: 'margin-right: 14px;' });
        }

        let textBox = new St.BoxLayout({ vertical: true });
        let titleLabel = new St.Label({ text: title, style: `font-weight: bold; color: ${appliedTitleColor}; font-size: ${this.result_font_size}px;` });
        let subLabel = new St.Label({ text: subtitle, style: `color: ${colors.textSecondary}; font-size: ${Math.max(9, this.result_font_size - 4)}px; margin-top: 2px;` });
        
        textBox.add_child(titleLabel);
        textBox.add_child(subLabel);

        itemBox.add_child(icon);
        itemBox.add_child(textBox);

        itemBox.titleLabel = titleLabel;
        itemBox.subLabel = subLabel;
        itemBox.originalTitleColor = appliedTitleColor;

        itemBox.actionFunc = actionFunc;
        itemBox.connect('button-press-event', () => { actionFunc(); return Clutter.EVENT_STOP; });

        this.resultsBox.add_child(itemBox);
        this.resultItems.push(itemBox);
    }

    async _showScriptResults(scriptQuery) {
        let scripts = await this._getScriptFiles();
        let uniqueScriptsMap = new Map();
        
        scripts.forEach(s => {
            let matchesQuery = !scriptQuery || s.name.toLowerCase().includes(scriptQuery);
            if (matchesQuery) {
                uniqueScriptsMap.set(s.path, s);
            }
        });

        uniqueScriptsMap.forEach((script) => {
            let fileExt = script.name.split('.').pop().toLowerCase();
            let iconName = 'utilities-terminal';
            let fileTypeLabel = "Shell Script";
            let textColor = '#38bdf8';

            if (fileExt === 'py') {
                iconName = 'text-x-script';
                fileTypeLabel = "Python Script";
                textColor = '#fbbf24';
            } else if (fileExt === 'sh') {
                iconName = 'utilities-terminal';
                fileTypeLabel = "Shell Script";
                textColor = '#34d399';
            }

            let subtitleText = `${fileTypeLabel} • ${script.path}`;

            this._addResultItem(
                iconName,
                script.name,
                subtitleText,
                () => this._runScript(script.path),
                textColor
            );
        });
        
        if (this.resultItems.length > 0 && this.activePanel === 'main') {
            this._setSelectedIndex(0);
        }
    }

    async _getScriptFiles() {
        let scripts = [];
        if (!this.script_paths) return scripts;

        let pathArray = this.script_paths.split(',').map(p => p.trim()).filter(p => p.length > 0);
        let homeDir = GLib.get_home_dir();
        
        for (let p of pathArray) {
            let resolvedPath = p.replace("~", homeDir);
            let dirFile = Gio.File.new_for_path(resolvedPath);
            
            try {
                let enumerator = await new Promise((resolve) => {
                    dirFile.enumerate_children_async(
                        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
                        (source_object, res) => {
                            try { resolve(source_object.enumerate_children_finish(res)); } 
                            catch (e) { resolve(null); }
                        }
                    );
                });

                if (enumerator) {
                    let files = await new Promise((resolve) => {
                        enumerator.next_files_async(500, GLib.PRIORITY_DEFAULT, null, (source_object, res) => {
                            try { resolve(source_object.next_files_finish(res)); } 
                            catch(e) { resolve([]); }
                        });
                    });
                    
                    if (files) {
                        files.forEach(fileInfo => {
                            let name = fileInfo.get_name();
                            if (name.endsWith('.sh') || name.endsWith('.py')) {
                                let fullPath = GLib.build_filenamev([resolvedPath, name]);
                                scripts.push({ name: name, path: fullPath });
                            }
                        });
                    }
                }
            } catch(e) {}
        }
        return scripts;
    }

    _runScript(path) {
        try {
            let terminalCmds = this.terminal_app.split(' ').map(c => c.trim()).filter(c => c.length > 0);
            let fileExt = path.split('.').pop().toLowerCase();
            let interpreter = (fileExt === 'py') ? 'python3' : 'bash';
            let argv = terminalCmds.concat([interpreter, path]);
            Util.spawn(argv);
        } catch(e) {
            Main.notify("Error", "Failed to run script");
        }
        this._toggleSpotlight();
    }

    _onKeyPress(actor, event) {
        let symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this._toggleSpotlight();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            if (this.activePanel === 'main' && this.sidebarItems.length > 0) {
                this.activePanel = 'sidebar';
                this._clearMainSelection();
                if (this.sidebarIndex === -1 || this.sidebarIndex >= this.sidebarItems.length) {
                    this._setSidebarIndex(0);
                } else {
                    this._setSidebarIndex(this.sidebarIndex);
                }
            } else if (this.activePanel === 'sidebar' && this.resultItems.length > 0) {
                this.activePanel = 'main';
                this._clearSidebarSelection();
                if (this.selectedIndex === -1 || this.selectedIndex >= this.resultItems.length) {
                    this._setSelectedIndex(0);
                } else {
                    this._setSelectedIndex(this.selectedIndex);
                }
            }
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up) {
            this.isNavigating = true;
            if (this.activePanel === 'main') {
                if (this.selectedIndex > 0) {
                    this._setSelectedIndex(this.selectedIndex - 1);
                } else if (this.selectedIndex === -1 && this.resultItems.length > 0) {
                    this._setSelectedIndex(0);
                }
            } else if (this.activePanel === 'sidebar') {
                if (this.sidebarIndex > 0) {
                    this._setSidebarIndex(this.sidebarIndex - 1);
                } else if (this.sidebarIndex === -1 && this.sidebarItems.length > 0) {
                    this._setSidebarIndex(0);
                }
            }
            Mainloop.timeout_add(50, () => { this.isNavigating = false; return false; });
            return Clutter.EVENT_STOP;
        } 
        
        if (symbol === Clutter.KEY_Down) {
            this.isNavigating = true;
            if (this.activePanel === 'main') {
                if (this.selectedIndex < this.resultItems.length - 1) {
                    this._setSelectedIndex(this.selectedIndex + 1);
                } else if (this.selectedIndex === -1 && this.resultItems.length > 0) {
                    this._setSelectedIndex(0);
                }
            } else if (this.activePanel === 'sidebar') {
                if (this.sidebarIndex < this.sidebarItems.length - 1) {
                    this._setSidebarIndex(this.sidebarIndex + 1);
                } else if (this.sidebarIndex === -1 && this.sidebarItems.length > 0) {
                    this._setSidebarIndex(0);
                }
            }
            Mainloop.timeout_add(50, () => { this.isNavigating = false; return false; });
            return Clutter.EVENT_STOP;
        } 
        
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (this.activePanel === 'main' && this.selectedIndex >= 0 && this.selectedIndex < this.resultItems.length) {
                this.resultItems[this.selectedIndex].actionFunc();
            } else if (this.activePanel === 'sidebar' && this.sidebarIndex >= 0 && this.sidebarIndex < this.sidebarItems.length) {
                this.sidebarItems[this.sidebarIndex].actionFunc();
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE; 
    }

    _setSelectedIndex(index) {
        this._clearMainSelection();
        this.selectedIndex = index;
        if (this.selectedIndex >= 0 && this.selectedIndex < this.resultItems.length) {
            try {
                let colors = this._getThemeColors();
                let selectedItem = this.resultItems[this.selectedIndex];
                selectedItem.set_style(`padding: 12px 14px; border-radius: 8px; margin-bottom: 4px; background-color: ${colors.highlight};`);
                
                if (selectedItem.titleLabel) {
                    selectedItem.titleLabel.set_style(`font-weight: bold; color: ${colors.selectedText}; font-size: ${this.result_font_size}px;`);
                }
                if (selectedItem.subLabel) {
                    selectedItem.subLabel.set_style(`color: ${colors.selectedSubText}; font-size: ${Math.max(9, this.result_font_size - 4)}px; margin-top: 2px;`);
                }

                Util.ensureActorVisibleInScrollView(this.scrollView, selectedItem);
            } catch(e) {}
        }
    }

    _clearMainSelection() {
        if (this.selectedIndex >= 0 && this.selectedIndex < this.resultItems.length) {
            try {
                let colors = this._getThemeColors();
                let item = this.resultItems[this.selectedIndex];
                let defaultBg = (this.selectedIndex === 0 && item.actionFunc && item.actionFunc.toString().includes('_copyToClipboard')) ? colors.searchBg : 'transparent';
                item.set_style(`padding: 12px 14px; border-radius: 8px; margin-bottom: 4px; background-color: ${defaultBg};`);
                
                if (item.titleLabel && item.originalTitleColor) {
                    item.titleLabel.set_style(`font-weight: bold; color: ${item.originalTitleColor}; font-size: ${this.result_font_size}px;`);
                }
                if (item.subLabel) {
                    item.subLabel.set_style(`color: ${colors.textSecondary}; font-size: ${Math.max(9, this.result_font_size - 4)}px; margin-top: 2px;`);
                }
            } catch(e) {}
        }
    }

    _setSidebarIndex(index) {
        this._clearSidebarSelection();
        this.sidebarIndex = index;
        if (this.sidebarIndex >= 0 && this.sidebarIndex < this.sidebarItems.length) {
            try {
                let colors = this._getThemeColors();
                let selectedItem = this.sidebarItems[this.sidebarIndex];
                selectedItem.set_style(`padding: 8px; border-radius: 8px; margin-bottom: 8px; background-color: ${colors.highlight};`);
                
                if (selectedItem.titleLabel) {
                    selectedItem.titleLabel.set_style(`font-weight: bold; color: ${colors.selectedText}; font-size: ${this.window_font_size}px;`);
                }
                if (selectedItem.subLabel) {
                    selectedItem.subLabel.set_style(`color: ${colors.selectedSubText}; font-size: ${Math.max(8, this.window_font_size - 2)}px; margin-top: 2px;`);
                }

                Util.ensureActorVisibleInScrollView(this.sidebarScroll, selectedItem);
            } catch(e) {}
        }
    }

    _clearSidebarSelection() {
        if (this.sidebarIndex >= 0 && this.sidebarIndex < this.sidebarItems.length) {
            try {
                let colors = this._getThemeColors();
                let item = this.sidebarItems[this.sidebarIndex];
                item.set_style(`padding: 8px; border-radius: 8px; margin-bottom: 8px; background-color: ${colors.sidebarItemBg};`);
                
                if (item.titleLabel) {
                    item.titleLabel.set_style(`font-weight: bold; color: ${colors.textPrimary}; font-size: ${this.window_font_size}px;`);
                }
                if (item.subLabel) {
                    item.subLabel.set_style(`color: ${colors.textSecondary}; font-size: ${Math.max(8, this.window_font_size - 2)}px; margin-top: 2px;`);
                }
            } catch(e) {}
        }
    }

    _activateWindow(win) {
        Main.activateWindow(win, global.get_current_time()); 
        this._toggleSpotlight(); 
    }

    _copyToClipboard(text) {
        let clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text.toString());
        Main.notify("Calculator", "Result copied to clipboard: " + text);
        this._toggleSpotlight();
    }
}

let spotlightExtension = null; 
function init(metadata) { spotlightExtension = new SpotlightExtension(metadata); } 
function enable() { if (spotlightExtension) spotlightExtension.enable(); } 
function disable() { if (spotlightExtension) spotlightExtension.disable(); }