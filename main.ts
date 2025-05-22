import { App, BaseComponent, ButtonComponent, Component, EventRef, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TextAreaComponent, TextComponent, TFile, Vault, Command, Editor, Hotkey, setIcon, FileSystemAdapter } from 'obsidian';

class RuleConfig {
	name: string;
	enabled: boolean;
	comments: string[];

	constructor(name: string, enabled: boolean = true, comments: string[] = []) {
		this.name = name;
		this.enabled = enabled;
		this.comments = comments;
	}
}

class RulesetIndex {
	header: string = "";
	rules: RuleConfig[] = [];
	footer: string = "";

	parse(content: string): void {
		const lines = content.split(/\r\n|\r|\n/);
		let headerLines: string[] = [];
		let inHeader = true;
		let currentComments: string[] = [];
		let footerStartIdx = lines.length;

		// Parse the file
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			
			// Skip empty lines in header, add them to comments otherwise
			if (line.trim() === "") {
				if (inHeader) {
					headerLines.push(line);
				} else {
					currentComments.push(line);
				}
				continue;
			}

			// Check if this is a commented rule
			const commentedRuleMatch = line.match(/^\s*#\s*(.+)$/);
			if (commentedRuleMatch) {
				inHeader = false;
				this.rules.push(new RuleConfig(commentedRuleMatch[1], false, [...currentComments]));
				currentComments = [];
				continue;
			}

			// Check if this is a comment line (not a commented rule)
			if (line.startsWith("#")) {
				currentComments.push(line);
				continue;
			}

			// This is a normal rule
			if (line.trim().length > 0) {
				inHeader = false;
				this.rules.push(new RuleConfig(line.trim(), true, [...currentComments]));
				currentComments = [];
			}
		}

		// Set the header and footer
		this.header = headerLines.join("\n");
		this.footer = currentComments.join("\n");
	}

	toString(): string {
		let result = this.header;
		
		for (let rule of this.rules) {
			// Add comments
			if (rule.comments.length > 0) {
				if (result.length > 0 && !result.endsWith("\n")) {
					result += "\n";
				}
				result += rule.comments.join("\n") + "\n";
			}

			// Add the rule itself
			if (rule.enabled) {
				result += rule.name + "\n";
			} else {
				result += "# " + rule.name + "\n";
			}
		}

		// Add footer
		if (this.footer.length > 0) {
			result += this.footer;
			if (!result.endsWith("\n")) {
				result += "\n";
			}
		}

		return result;
	}

	// Get a list of enabled rules
	getEnabledRules(): string[] {
		return this.rules
			.filter(rule => rule.enabled)
			.map(rule => rule.name);
	}

	// Move a rule from one position to another
	moveRule(fromIndex: number, toIndex: number): void {
		if (fromIndex < 0 || fromIndex >= this.rules.length || 
			toIndex < 0 || toIndex >= this.rules.length) {
			return;
		}

		const [rule] = this.rules.splice(fromIndex, 1);
		this.rules.splice(toIndex, 0, rule);
	}

	// Add a new rule
	addRule(name: string, enabled: boolean = true): void {
		this.rules.push(new RuleConfig(name, enabled));
	}

	// Check if a rule exists
	ruleExists(name: string): boolean {
		return this.rules.some(rule => rule.name === name);
	}
}

export default class RegexPipeline extends Plugin {
	rules: string[]
	rulesetIndex: RulesetIndex = new RulesetIndex();
	allRuleFiles: string[] = []; // All rule files in the directory
	pathToRulesets = this.app.vault.configDir + "/regex-rulesets";
	indexFile = "/index.txt"
	menu: ApplyRuleSetMenu
	configs: SavedConfigs
	rightClickEventRef: EventRef
	quickCommands : Command[]
	quickRulesChanged : boolean

	log (message?: any, ...optionalParams: any[])
	{
		// comment this to disable logging
		console.log("[regex-pipeline] " + message);
	}

	async onload() {
		this.log('loading');
		this.addSettingTab(new ORPSettings(this.app, this))
		this.configs = await this.loadData()
		if (this.configs == null) this.configs = new SavedConfigs(3, 3, false)
		if (this.configs.rulesInVault) this.pathToRulesets = "/regex-rulesets"
		this.menu = new ApplyRuleSetMenu(this.app, this)
		this.menu.contentEl.className = "rulesets-menu-content"
		this.menu.titleEl.className = "rulesets-menu-title"

		this.addRibbonIcon('dice', 'Regex Rulesets', () => {
			this.menu.open();
		});

		this.addCommand({
			id: 'apply-ruleset',
			name: 'Apply Ruleset',
			// callback: () => {
			// 	this.log('Simple Callback');
			// },
			checkCallback: (checking: boolean) => {
				let leaf = this.app.workspace.activeLeaf;
				if (leaf) {
					if (!checking) {
						this.menu.open();
					}
					return true;
				}
				return false;
			}
		});

		this.reloadRulesets();
		this.log("Rulesets: " + this.pathToRulesets);
		this.log("Index: " + this.pathToRulesets + this.indexFile);

	}

	onunload() {
		this.log('unloading');
		if (this.rightClickEventRef != null) this.app.workspace.offref(this.rightClickEventRef)
	}

	async scanRuleFiles() {
		this.allRuleFiles = [];
		
		// Create the ruleset directory if it doesn't exist
		if (!await this.app.vault.adapter.exists(this.pathToRulesets)) {
			await this.app.vault.createFolder(this.pathToRulesets);
			return; // No files yet since directory was just created
		}
		
		// Get all files in the ruleset directory
		const files = await this.app.vault.adapter.list(this.pathToRulesets);
		
		// Filter out directories and the index file
		const ruleFiles = files.files.filter(file => {
			const fileName = file.substring(file.lastIndexOf('/') + 1);
			return fileName !== "index.txt";
		}).map(file => file.substring(file.lastIndexOf('/') + 1));
		
		this.allRuleFiles = ruleFiles;
		this.log("All rule files: " + this.allRuleFiles);
		
		return ruleFiles;
	}

	async reloadRulesets() {
		// Create necessary folders and files
		if (!await this.app.vault.adapter.exists(this.pathToRulesets))
			await this.app.vault.createFolder(this.pathToRulesets)
		if (!await this.app.vault.adapter.exists(this.pathToRulesets + this.indexFile))
			await this.app.vault.adapter.write(this.pathToRulesets + this.indexFile, "").catch((r) => {
				new Notice("Failed to write to index file: " + r)
			});

		// Scan for all rule files in the directory
		await this.scanRuleFiles();

		// Read and parse the index file
		try {
			const indexContent = await this.app.vault.adapter.read(this.pathToRulesets + this.indexFile);
			this.rulesetIndex = new RulesetIndex();
			this.rulesetIndex.parse(indexContent);
			
			// Update the rules array for backward compatibility
			this.rules = this.rulesetIndex.getEnabledRules();
			
			this.log("Enabled rules: " + this.rules);
			this.updateRightclickMenu();
			this.updateQuickCommands();
		} catch (error) {
			new Notice("Failed to read or parse the index file: " + error);
			this.log("Error reloading rulesets: " + error);
		}
	}

	async updateQuickCommands () {
		if (this.configs.quickCommands <= 0) return;
		if (this.quickCommands == null) this.quickCommands = new Array<Command>();
		let expectedCommands = Math.min(this.configs.quickCommands, this.rules.length);
		// this.log(`setting up ${expectedCommands} commands...`)
		for (let i = 0; i < expectedCommands; i++)
		{
			let r = this.rules[i];
			let c = this.addCommand({
				id: `ruleset: ${r}`,
				name: r,
				editorCheckCallback: (checking: boolean) => {
					if (checking) return this.rules.contains(r);
					this.applyRuleset(this.pathToRulesets + "/" + r);
				},
			});
			// this.log(`pusing ${r} command...`)
			this.quickCommands.push(c);
			this.log(this.quickCommands)
		}
	}

	async updateRightclickMenu () {
		if (this.rightClickEventRef != null) this.app.workspace.offref(this.rightClickEventRef)
		this.rightClickEventRef = this.app.workspace.on("editor-menu", (menu) => {
			for (let i = 0; i < Math.min(this.configs.quickRules, this.rules.length); i++)
			{
				let rPath = this.pathToRulesets + "/" + this.rules[i]
				
				menu.addItem((item) => {
					item.setTitle("Regex Pipeline: " + this.rules[i])
					.onClick(() => {
						this.applyRuleset(rPath)
					});
				});
			}
		})
		this.registerEvent(this.rightClickEventRef)
	}

	async appendRulesetsToIndex(name : string) : Promise<boolean> {
		var result : boolean = true
		
		// Add to the rulesetIndex
		if (!this.rulesetIndex.ruleExists(name)) {
			this.rulesetIndex.addRule(name, true);
		}
		
		// Update the rules array (for backward compatibility)
		this.rules = this.rulesetIndex.getEnabledRules();
		
		// Write the index file
		const newIndexValue = this.rulesetIndex.toString();
		await this.app.vault.adapter.write(this.pathToRulesets + this.indexFile, newIndexValue).catch((r) => {
			new Notice("Failed to write to index file: " + r)
			result = false;
		});

		return result;
	}

	async createRuleset (name : string, content : string) : Promise<boolean> {
		var result : boolean = true
		this.log("createRuleset: " + name);
		var path = this.pathToRulesets + "/" + name;
		if (await this.app.vault.adapter.exists(path)) {
			this.log("file existed: " + path);
			return false;
		}

		await this.app.vault.adapter.write(path, content).catch((r) => {
			new Notice("Failed to write the ruleset file: " + r)
			result = false;
		});

		result = await this.appendRulesetsToIndex(name)
		return true;
	}

	async applyRuleset (ruleset : string) {
		if (!await this.app.vault.adapter.exists(ruleset)) {
			new Notice(ruleset + " not found!");
			return
		}
		let ruleParser = /^"(.+?)"([a-z]*?)(?:\r\n|\r|\n)?->(?:\r\n|\r|\n)?"(.*?)"([a-z]*?)(?:\r\n|\r|\n)?$/gmus;
		let ruleText = await this.app.vault.adapter.read(ruleset);

		let activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView == null)
		{
			new Notice("No active Markdown file!");
			return;
		}

		let subject;
		let selectionMode;
		if (activeMarkdownView.editor.somethingSelected())
		{
			subject = activeMarkdownView.editor.getSelection();
			selectionMode = true;
		}
		else
		{
			subject = activeMarkdownView.editor.getValue();
		}

		let pos = activeMarkdownView.editor.getScrollInfo()
		this.log(pos.top)

		let count = 0;
		let ruleMatches;
		while (ruleMatches = ruleParser.exec(ruleText))
		{
			if (ruleMatches == null) break;
			this.log("\n" + ruleMatches[1] + "\n↓↓↓↓↓\n"+ ruleMatches[3]);

			let matchRule = ruleMatches[2].length == 0? new RegExp(ruleMatches[1], 'gm') : new RegExp(ruleMatches[1], ruleMatches[2]);
			if (ruleMatches[4] == 'x') subject = subject.replace(matchRule, '');
			else subject = subject.replace(matchRule, ruleMatches[3]);
			count++;
		}
		if (selectionMode)
			activeMarkdownView.editor.replaceSelection(subject);
		else
			activeMarkdownView.editor.setValue(subject);

		activeMarkdownView.requestSave();
		activeMarkdownView.editor.scrollTo(0, pos.top)
		new Notice("Executed ruleset '" + ruleset + "' which contains " + count + " regex replacements!");

	}
}

class SavedConfigs {
	constructor(quickRules: number, quickCommands : number, rulesInVault: boolean) {
		this.quickRules = quickRules
		this.rulesInVault = rulesInVault
		this.quickCommands = quickCommands
	}
	quickRules: number
	quickCommands : number
	rulesInVault: boolean
}

class ORPSettings extends PluginSettingTab {

	plugin: RegexPipeline;
	ruleListContainer: HTMLElement;
	nonListedRuleContainer: HTMLElement;
	dragging: boolean = false;
	draggedIndex: number = -1;

	constructor(app: App, plugin: RegexPipeline) {
		super(app, plugin);
	}

	quickRulesCache : number

	async display() {
		this.containerEl.empty();

		// General settings
		this.containerEl.createEl('h2', { text: 'General Settings' });

		new Setting(this.containerEl)
			.setName("Quick Rules")
			.setDesc("The first N rulesets in your index file will be available in the right click menu.")
			.addSlider(c => {
				c.setValue(this.plugin.configs.quickRules)
				c.setLimits(0, 10, 1)
				c.setDynamicTooltip()
				c.showTooltip()
				c.onChange((v) => {
					if (v != this.plugin.configs.quickRules) this.plugin.quickRulesChanged = true;
					this.plugin.configs.quickRules = v;
				})
			}) 
		new Setting(this.containerEl)
			.setName("Quick Rule Commands")
			.setDesc("The first N rulesets in your index file will be available as Obsidian commands. When changing this count or re-ordering rulesets, existing commands will not be removed until next reload (You can also manually re-enable the plugin).")
			.addSlider(c => {
				c.setValue(this.plugin.configs.quickCommands)
				c.setLimits(0, 10, 1)
				c.setDynamicTooltip()
				c.showTooltip()
				c.onChange(async (v) => {
					this.plugin.configs.quickCommands = v;
					this.plugin.updateQuickCommands();
					// Update the UI to refresh the Quick Command indicators
					await this.refreshRules();
				})
			}) 
		new Setting(this.containerEl)
			.setName("Save Ruleset Index In Vault")
			.setDesc("Reads the ruleset index from \".obsidian/regex-rulesets\" when off, \"./regex-ruleset\" when on (useful if you are user of ObsidianSync). ")
			.addToggle(c => {
				c.setValue(this.plugin.configs.rulesInVault)
				c.onChange(v => {
					this.plugin.configs.rulesInVault = v
					if (v) this.plugin.pathToRulesets = "/regex-rulesets"
					else this.plugin.pathToRulesets = this.app.vault.configDir + "/regex-rulesets"
				})
			})

		// Ruleset list management section
		this.containerEl.createEl('h2', { text: 'Ruleset Management' });
		const desc = this.containerEl.createEl('p', { text: 'Manage rulesets in the index. Disabled rulesets will not be applied in menus and commands.' });
		desc.style.opacity = '0.7';

		// Container for the ruleset list
		this.ruleListContainer = this.containerEl.createEl('div');
		this.ruleListContainer.addClass('regex-pipeline-rule-list');

		// Container for rulesets not in the index
		this.nonListedRuleContainer = this.containerEl.createEl('div');

		// Refresh button
		const refreshContainer = this.containerEl.createEl('div');
		refreshContainer.addClass('regex-pipeline-refresh-container');
		const refreshButton = new ButtonComponent(refreshContainer);
		refreshButton.setButtonText('Refresh Rulesets');
		refreshButton.onClick(() => this.refreshRules());

		// Render the ruleset list
		await this.refreshRules();
	}

	async refreshRules() {
		// Reload the rulesets to get the latest data
		await this.plugin.reloadRulesets();

		// Clear the containers
		this.ruleListContainer.empty();
		this.nonListedRuleContainer.empty();

		// Special case for when there's no index.txt or the file is empty
		if (this.plugin.rulesetIndex.rules.length === 0) {
			const emptyMessage = this.ruleListContainer.createEl('div', {
				text: 'No rulesets found in index file. Create a ruleset or add existing files to the index.'
			});
			emptyMessage.addClass('regex-pipeline-empty-message');

			// Add button to create a new ruleset
			const createButton = new ButtonComponent(this.ruleListContainer);
			createButton.setButtonText('Create New Ruleset');
			createButton.buttonEl.addClass('regex-pipeline-create-button');
			createButton.onClick(() => {
				new NewRulesetPanel(this.app, this.plugin).open();
			});
		} else {
			// Render each ruleset in the index
			this.plugin.rulesetIndex.rules.forEach((rule, index) => {
				this.renderRuleItem(rule, index);
			});
		}

		// Render rulesets not in the index
		const indexedRuleNames = this.plugin.rulesetIndex.rules.map(r => r.name);
		const nonIndexedRules = this.plugin.allRuleFiles.filter(file => !indexedRuleNames.includes(file));

		// Only show the unlisted rulesets section if there are any
		if (nonIndexedRules.length > 0) {
			// First create the heading and description
			this.containerEl.createEl('h3', { text: 'Unlisted Rulesets' });
			const unlDesc = this.containerEl.createEl('p', {
				text: 'Files in the rulesets directory that are not in the index.'
			});
			unlDesc.style.opacity = '0.7';

			// Then render the unlisted rulesets
			nonIndexedRules.forEach(file => {
				const fileItem = this.nonListedRuleContainer.createEl('div');
				fileItem.addClass('regex-pipeline-rule-item');
				fileItem.addClass('regex-pipeline-unlisted-rule');

				const fileNameEl = fileItem.createEl('span', { text: file });
				fileNameEl.addClass('regex-pipeline-rule-name');

				const addButton = new ButtonComponent(fileItem);
				addButton.setButtonText('Add to Index');
				addButton.onClick(async () => {
					await this.plugin.appendRulesetsToIndex(file);
					await this.refreshRules();
				});
			});
		}
	}

	renderRuleItem(rule: RuleConfig, index: number) {
		const ruleItem = this.ruleListContainer.createEl('div');
		ruleItem.addClass('regex-pipeline-rule-item');
		ruleItem.setAttribute('data-index', String(index));
		ruleItem.setAttribute('draggable', 'true');

		// Determine if this is a Quick Command ruleset by counting enabled rules before this one
		const enabledRulesBefore = this.plugin.rulesetIndex.rules.slice(0, index).filter(r => r.enabled).length;
		const isQuickCommand = rule.enabled && enabledRulesBefore < this.plugin.configs.quickCommands;

		if (isQuickCommand) {
			ruleItem.addClass('regex-pipeline-quick-command');
		}

		// Handle drag events
		ruleItem.addEventListener('dragstart', (e) => {
			this.dragging = true;
			this.draggedIndex = index;
			ruleItem.addClass('dragging');
		});

		ruleItem.addEventListener('dragover', (e) => {
			e.preventDefault();
			ruleItem.addClass('drag-over');
		});

		ruleItem.addEventListener('dragleave', () => {
			ruleItem.removeClass('drag-over');
		});

		ruleItem.addEventListener('drop', async (e) => {
			e.preventDefault();
			ruleItem.removeClass('drag-over');

			if (this.dragging && this.draggedIndex !== index) {
				// Move the ruleset in the index
				this.plugin.rulesetIndex.moveRule(this.draggedIndex, index);

				// Update the rules array
				this.plugin.rules = this.plugin.rulesetIndex.getEnabledRules();

				// Write the changes to the index file
				const newIndexValue = this.plugin.rulesetIndex.toString();
				await this.plugin.app.vault.adapter.write(this.plugin.pathToRulesets + this.plugin.indexFile, newIndexValue);

				// Refresh the UI
				await this.refreshRules();
				this.plugin.updateRightclickMenu();
				this.plugin.updateQuickCommands();
			}
		});

		ruleItem.addEventListener('dragend', () => {
			this.dragging = false;
			ruleItem.removeClass('dragging');
			const items = this.ruleListContainer.querySelectorAll('.regex-pipeline-rule-item');
			items.forEach(item => item.removeClass('drag-over'));
		});

		// Drag handle
		const dragHandle = ruleItem.createEl('div');
		dragHandle.addClass('regex-pipeline-drag-handle');
		setIcon(dragHandle, 'lucide-grip-vertical');

		// Enable/disable toggle
		const toggleContainer = ruleItem.createEl('div');
		toggleContainer.addClass('regex-pipeline-toggle-container');
		const toggle = new ButtonComponent(toggleContainer);
		toggle.setIcon(rule.enabled ? 'lucide-check-circle' : 'lucide-circle');
		toggle.setTooltip(rule.enabled ? 'Disable' : 'Enable');
		toggle.buttonEl.addClass(rule.enabled ? 'regex-pipeline-enabled' : 'regex-pipeline-disabled');
		toggle.onClick(async () => {
			// Toggle the ruleset's enabled state
			rule.enabled = !rule.enabled;

			// Update the rules array
			this.plugin.rules = this.plugin.rulesetIndex.getEnabledRules();

			// Write the changes to the index file
			const newIndexValue = this.plugin.rulesetIndex.toString();
			await this.plugin.app.vault.adapter.write(this.plugin.pathToRulesets + this.plugin.indexFile, newIndexValue);

			// Refresh the toggle button
			toggle.setIcon(rule.enabled ? 'lucide-check-circle' : 'lucide-circle');
			toggle.setTooltip(rule.enabled ? 'Disable' : 'Enable');
			toggle.buttonEl.removeClass(rule.enabled ? 'regex-pipeline-disabled' : 'regex-pipeline-enabled');
			toggle.buttonEl.addClass(rule.enabled ? 'regex-pipeline-enabled' : 'regex-pipeline-disabled');

			// Update menus and commands
			this.plugin.updateRightclickMenu();
			this.plugin.updateQuickCommands();

			// Refresh the UI to update Quick Command indicators
			await this.refreshRules();
		});

		// Ruleset name
		const nameEl = ruleItem.createEl('span', { text: rule.name });
		nameEl.addClass('regex-pipeline-rule-name');

		// Check if the file exists
		const fileExists = this.plugin.allRuleFiles.includes(rule.name);
		if (!fileExists) {
			nameEl.addClass('regex-pipeline-missing-file');
			nameEl.setAttr('title', 'File not found in rulesets directory');
		}

		// Add Quick Command indicator if this is one of the first N enabled rulesets
		if (isQuickCommand) {
			const quickCommandIndicator = ruleItem.createEl('div', { text: 'QC' });
			quickCommandIndicator.addClass('regex-pipeline-quick-command-indicator');
			quickCommandIndicator.setAttr('title', 'This ruleset is available as a Quick Command');
		}

		// Add "Show in Explorer" button only if the file exists
		if (fileExists) {
			const showInExplorerButton = new ButtonComponent(ruleItem);
			showInExplorerButton.setIcon('lucide-folder');
			showInExplorerButton.setTooltip('Show in File Explorer');
			showInExplorerButton.buttonEl.addClass('regex-pipeline-explorer-button');
			showInExplorerButton.onClick(() => {
				const filePath = this.plugin.pathToRulesets + '/' + rule.name;
				this.showInFileExplorer(filePath);
			});
		}
	}

	// Helper function to open the file in system file explorer
	showInFileExplorer(filePath: string) {
		// Use Electron's shell to show the file in the system file explorer
		if (require) {
			try {
				const { shell } = require('electron');
				const path = require('path');
				// Use getFullPath to get the absolute path
				const adapter = this.app.vault.adapter as FileSystemAdapter;
				const fullPath = adapter.getFullPath(filePath);
				shell.showItemInFolder(fullPath);
				return true;
			} catch (error) {
				console.error("Failed to open file in explorer:", error);
				new Notice("Failed to open file in explorer");
				return false;
			}
		} else {
			new Notice("Cannot open file in explorer in this environment");
			return false;
		}
	}

	hide() {
		this.plugin.reloadRulesets();
		this.plugin.saveData(this.plugin.configs);
	}
}

class ApplyRuleSetMenu extends Modal {
	plugin: RegexPipeline;
	constructor(app: App, plugin: RegexPipeline) {
		super(app);
		this.plugin = plugin;
		this.modalEl.style.setProperty("width", "60vw");
		this.modalEl.style.setProperty("max-height", "60vh");
		this.modalEl.style.setProperty("padding", "2rem");
		this.titleEl.createEl("h1", null, el => {
			el.innerHTML = this.plugin.pathToRulesets + "/...";
			el.style.setProperty("display", "inline-block");
			el.style.setProperty("width", "92%");
			el.style.setProperty("max-width", "480px");
			el.style.setProperty("margin", "12 0 8");
		});
		this.titleEl.createEl("h1", null, el => { el.style.setProperty("flex-grow", "1") });
		var reloadButton = new ButtonComponent(this.titleEl)
			.setButtonText("RELOAD")
			.onClick(async (evt) => {
				await this.plugin.reloadRulesets();
				this.onClose();
				this.onOpen();
			});
		reloadButton.buttonEl.style.setProperty("display", "inline-block")
		reloadButton.buttonEl.style.setProperty("bottom", "8px")
		reloadButton.buttonEl.style.setProperty("margin", "auto")
	}

	onOpen() {
		for (let i = 0; i < this.plugin.rules.length; i++) {
			// new Setting(contentEl)
			// 	.setName(this.plugin.rules[i])
			// 	.addButton(btn => btn.onClick(async () => {
			// 		this.plugin.applyRuleset(this.plugin.pathToRulesets + "/" + this.plugin.rules[i])
			// 		this.close();
			// 	}).setButtonText("Apply"));
			var ruleset = new ButtonComponent(this.contentEl)
				.setButtonText(this.plugin.rules[i])
				.onClick(async (evt) => {
					this.plugin.applyRuleset(this.plugin.pathToRulesets + "/" + this.plugin.rules[i])
					this.close();
				});
			ruleset.buttonEl.className = "apply-ruleset-button";
		}
		this.titleEl.getElementsByTagName("h1")[0].innerHTML = this.plugin.pathToRulesets + "/...";
		var addButton = new ButtonComponent(this.contentEl)
			.setButtonText("+")
			.onClick(async (evt) => {
				new NewRulesetPanel(this.app, this.plugin).open();
			});
		addButton.buttonEl.className = "add-ruleset-button";
		addButton.buttonEl.style.setProperty("width", "3.3em");
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}

class NewRulesetPanel extends Modal {

	plugin: RegexPipeline;
	constructor(app: App, plugin: RegexPipeline) {
		super(app);
		this.plugin = plugin;
		this.contentEl.className = "ruleset-creation-content"
	}

	onOpen() {
		var nameHint = this.contentEl.createEl("h4");
		nameHint.innerHTML = "Name";
		this.contentEl.append(nameHint);
		var nameInput = this.contentEl.createEl("textarea");
		nameInput.setAttr("rows", "1");
		nameInput.addEventListener('keydown', (e) => {
			if (e.key === "Enter") e.preventDefault();
		});
		this.contentEl.append(nameInput);
		var contentHint = this.contentEl.createEl("h4");
		contentHint.innerHTML = "Content";
		this.contentEl.append(contentHint);
		var contentInput = this.contentEl.createEl("textarea");
		contentInput.style.setProperty("height", "300px");
		this.contentEl.append(contentInput);
		var saveButton = new ButtonComponent(this.contentEl)
			.setButtonText("Save")
			.onClick(async (evt) => {
				if (!await this.plugin.createRuleset(nameInput.value, contentInput.value)) {
					new Notice("Failed to create the ruleset! Please check if the file already exist.");
					return
				}
				this.plugin.menu.onClose();
				this.plugin.menu.onOpen();
				this.close()
			});
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}