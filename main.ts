import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, base64ToArrayBuffer } from 'obsidian';
import { createLogger } from '@tomelliot/obsidian-logger';

const log = createLogger('Convert Base64 to PNG');

interface ConvertBase64ToPNGSettings {
	outputFolder: string;
	autoConvert: boolean;
	filenameFormat: string;
	debugLogging: boolean;
}

const DEFAULT_SETTINGS: ConvertBase64ToPNGSettings = {
	outputFolder: 'attachments',
	autoConvert: false,
	filenameFormat: 'image-{{date}}-{{index}}',
	debugLogging: false,
}

const LOG_FILENAME = 'debug.log';
const MAX_LOG_SIZE = 1024 * 1024; // 1 MB

interface Base64Match {
	fullMatch: string;
	altText: string;
	imageType: string;
	base64Data: string;
	/** Which syntax pattern matched */
	syntax: 'inline' | 'reference' | 'html';
	/** For reference-style: the reference id so we can also remove the usage */
	refId?: string;
}

// Inline: ![alt](data:image/png;base64,...)
const INLINE_REGEX = /!\[(.*?)\]\(data:image\/([a-zA-Z+]+);base64,([^)]+)\)/g;
// Reference definition: [id]: <data:image/png;base64,...> or without angle brackets
const REFERENCE_DEF_REGEX = /^\[([^\]]+)\]:\s*<?data:image\/([a-zA-Z+]+);base64,([^>\s]+)>?$/gm;
// HTML img: <img ... src="data:image/png;base64,..." ...>
const HTML_IMG_REGEX = /<img[^>]+src=["']data:image\/([a-zA-Z+]+);base64,([^"']+)["'][^>]*>/g;

function findBase64Images(content: string): Base64Match[] {
	const matches: Base64Match[] = [];

	let m;
	while ((m = INLINE_REGEX.exec(content)) !== null) {
		matches.push({
			fullMatch: m[0],
			altText: m[1],
			imageType: m[2],
			base64Data: m[3],
			syntax: 'inline',
		});
	}

	while ((m = REFERENCE_DEF_REGEX.exec(content)) !== null) {
		matches.push({
			fullMatch: m[0],
			altText: m[1],
			imageType: m[2],
			base64Data: m[3],
			syntax: 'reference',
			refId: m[1],
		});
	}

	while ((m = HTML_IMG_REGEX.exec(content)) !== null) {
		const altMatch = m[0].match(/alt=["']([^"']*)["']/);
		matches.push({
			fullMatch: m[0],
			altText: altMatch ? altMatch[1] : '',
			imageType: m[1],
			base64Data: m[2],
			syntax: 'html',
		});
	}

	return matches;
}

function containsBase64(content: string): boolean {
	return content.includes('data:image/') && content.includes(';base64,');
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default class ConvertBase64ToPNGPlugin extends Plugin {
	settings: ConvertBase64ToPNGSettings;

	async onload() {
		await this.loadSettings();
		this.configureFileLogging();

		log.info('Plugin loaded, settings:', {
			outputFolder: this.settings.outputFolder,
			autoConvert: this.settings.autoConvert,
			filenameFormat: this.settings.filenameFormat,
			debugLogging: this.settings.debugLogging,
		});

		// Add command to convert base64 images in current file
		this.addCommand({
			id: 'convert-base64-to-png-current-file',
			name: 'Convert Base64 images to PNG for current file',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.convertBase64ToPNG(editor, view.file);
			}
		});

		// Add command to convert base64 images in all files
		this.addCommand({
			id: 'convert-base64-to-png-all-files',
			name: 'Convert Base64 images to PNG for all files',
			callback: () => {
				this.convertAllFilesBase64ToPNG();
			}
		});

		// Add settings tab
		this.addSettingTab(new ConvertBase64ToPNGSettingTab(this.app, this));

		// Register event for auto-conversion if enabled
		if (this.settings.autoConvert) {
			log.debug('Auto-convert enabled, registering paste handler');
			this.registerEvent(
				this.app.workspace.on('editor-paste', (_: ClipboardEvent, editor: Editor) => {
					setTimeout(() => {
						const content = editor.getValue();
						if (this.containsBase64Image(content)) {
							log.debug('Base64 image detected in paste, triggering auto-convert');
							this.convertBase64ToPNG(editor, this.app.workspace.getActiveFile());
						}
					}, 100);
				})
			);
		}
	}

	onunload() {
		log.info('Plugin unloaded');
	}

	private configureFileLogging() {
		const pluginDir = this.manifest.dir;
		if (!pluginDir) {
			log.warn('Plugin directory not available, file logging disabled');
			return;
		}

		const logPath = normalizePath(`${pluginDir}/${LOG_FILENAME}`);

		log.configureFileLogging({
			isDebugEnabled: () => this.settings.debugLogging,
			appendLine: async (line: string) => {
				try {
					await this.app.vault.adapter.append(logPath, line);
				} catch {
					// File may not exist yet — create it
					try {
						await this.app.vault.adapter.write(logPath, line);
					} catch {
						// Swallow errors to avoid affecting plugin behavior
					}
				}
			},
		});

		this.rotateLogFile(logPath);
	}

	private async rotateLogFile(logPath: string) {
		try {
			const stat = await this.app.vault.adapter.stat(logPath);
			if (stat && stat.size > MAX_LOG_SIZE) {
				const existing = await this.app.vault.adapter.read(logPath);
				const truncated = existing.slice(existing.length - MAX_LOG_SIZE / 2);
				const firstNewline = truncated.indexOf('\n');
				await this.app.vault.adapter.write(
					logPath,
					firstNewline !== -1 ? truncated.slice(firstNewline + 1) : truncated
				);
			}
		} catch {
			// Log file doesn't exist or can't be read — nothing to rotate
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	containsBase64Image(content: string): boolean {
		return containsBase64(content);
	}

	// Convert base64 images in current file
	async convertCurrentFileBase64ToPNG() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			const editor = activeView.editor;
			const file = activeView.file;
			await this.convertBase64ToPNG(editor, file);
		} else {
			new Notice('No active markdown file');
		}
	}

	// Main conversion function
	async convertBase64ToPNG(editor: Editor, file: TFile | null) {
		if (!file) {
			log.warn('convertBase64ToPNG called with no active file');
			new Notice('No file is currently open');
			return;
		}

		log.info('Starting conversion for file:', file.path);

		const content = editor.getValue();
		let newContent = content;
		let conversionCount = 0;
		const matches = findBase64Images(content);

		if (matches.length === 0) {
			log.debug('No base64 images found in file:', file.path);
			new Notice('No base64 images found in the current file');
			return;
		}

		log.info(`Found ${matches.length} base64 image(s) in file:`, file.path,
			matches.map(m => `[${m.syntax}: type=${m.imageType}, base64 len=${m.base64Data.length}]`).join(', '));

		// Create output folder if it doesn't exist
		const filePath = file.path;
		const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
		const outputFolderPath = normalizePath(`${fileDir}/${this.settings.outputFolder}`);

		try {
			await this.app.vault.adapter.mkdir(outputFolderPath);
		} catch (error) {
			// Folder might already exist, which is fine
		}

		// Process each match
		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];

			try {
				// Generate filename
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				const filename = this.settings.filenameFormat
					.replace('{{date}}', timestamp)
					.replace('{{index}}', (i + 1).toString())
					.replace('{{type}}', match.imageType) + '.png';

				const imagePath = normalizePath(`${outputFolderPath}/${filename}`);
				const relativeImagePath = normalizePath(`${this.settings.outputFolder}/${filename}`);

				log.debug(`Converting image ${i + 1}/${matches.length}: syntax=${match.syntax}, type=${match.imageType}, base64 length=${match.base64Data.length}, output=${imagePath}`);

				const binaryData = base64ToArrayBuffer(match.base64Data);
				await this.app.vault.adapter.writeBinary(imagePath, binaryData);

				// Replace in content — for reference-style, replace the definition line
				// and update any usages like ![alt][refId] to ![alt](path)
				const newImageMarkdown = `![${match.altText}](${relativeImagePath})`;
				newContent = newContent.replace(match.fullMatch, newImageMarkdown);
				if (match.syntax === 'reference' && match.refId) {
					// Replace usages of the reference: ![alt][refId] or ![refId]
					const refUsage = new RegExp(`!\\[([^\\]]*)\\]\\[${escapeRegex(match.refId)}\\]`, 'g');
					newContent = newContent.replace(refUsage, (_, alt) => `![${alt}](${relativeImagePath})`);
					const shortRefUsage = new RegExp(`!\\[${escapeRegex(match.refId)}\\](?!\\[|\\()`, 'g');
					newContent = newContent.replace(shortRefUsage, `![${match.refId}](${relativeImagePath})`);
				}

				conversionCount++;
				log.debug(`Image ${i + 1} saved to ${imagePath}`);
			} catch (error) {
				log.error(`Error converting image ${i + 1}:`, error);
				new Notice(`Error converting image ${i + 1}: ${error.message}`);
			}
		}

		// Update the file content
		editor.setValue(newContent);

		log.info(`Conversion complete: ${conversionCount}/${matches.length} images converted in ${file.path}`);
	}

	// Convert base64 images in all markdown files
	async convertAllFilesBase64ToPNG() {
		const files = this.app.vault.getMarkdownFiles();
		let totalConversions = 0;
		let processedFiles = 0;

		log.info(`Starting batch conversion across ${files.length} files`);
		new Notice(`Processing ${files.length} files...`);

		let filesWithBase64 = 0;

		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);

				if (!this.containsBase64Image(content)) {
					processedFiles++;
					continue;
				}

				filesWithBase64++;
				const matches = findBase64Images(content);

				if (matches.length === 0) {
					log.warn(`File contains 'data:image/...;base64,' but no regex matched: ${file.path}`);
					log.debug(`First 200 chars around base64 in ${file.path}:`,
						content.substring(
							Math.max(0, content.indexOf('base64,') - 80),
							content.indexOf('base64,') + 120
						));
					processedFiles++;
					continue;
				}

				log.info(`Processing ${file.path}: ${matches.length} image(s) found`,
					matches.map(m => `[${m.syntax}: ${m.imageType}]`).join(', '));

				let newContent = content;
				let fileConversionCount = 0;

				const filePath = file.path;
				const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
				const outputFolderPath = normalizePath(`${fileDir}/${this.settings.outputFolder}`);

				try {
					await this.app.vault.adapter.mkdir(outputFolderPath);
				} catch (error) {
					// Folder might already exist
				}

				for (let i = 0; i < matches.length; i++) {
					const match = matches[i];

					try {
						const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
						const filename = this.settings.filenameFormat
							.replace('{{date}}', timestamp)
							.replace('{{index}}', (i + 1).toString())
							.replace('{{type}}', match.imageType) + '.png';

						const imagePath = normalizePath(`${outputFolderPath}/${filename}`);
						const relativeImagePath = normalizePath(`${this.settings.outputFolder}/${filename}`);

						log.debug(`Converting image ${i + 1}/${matches.length} in ${file.path}: syntax=${match.syntax}, type=${match.imageType}, base64 length=${match.base64Data.length}`);

						const binaryData = base64ToArrayBuffer(match.base64Data);
						await this.app.vault.adapter.writeBinary(imagePath, binaryData);

						const newImageMarkdown = `![${match.altText}](${relativeImagePath})`;
						newContent = newContent.replace(match.fullMatch, newImageMarkdown);
						if (match.syntax === 'reference' && match.refId) {
							const refUsage = new RegExp(`!\\[([^\\]]*)\\]\\[${escapeRegex(match.refId)}\\]`, 'g');
							newContent = newContent.replace(refUsage, (_, alt) => `![${alt}](${relativeImagePath})`);
							const shortRefUsage = new RegExp(`!\\[${escapeRegex(match.refId)}\\](?!\\[|\\()`, 'g');
							newContent = newContent.replace(shortRefUsage, `![${match.refId}](${relativeImagePath})`);
						}

						fileConversionCount++;
						log.debug(`Image ${i + 1} in ${file.path} saved to ${imagePath}`);
					} catch (error) {
						log.error(`Error converting image ${i + 1} in ${file.path}:`, error);
					}
				}

				if (fileConversionCount > 0) {
					await this.app.vault.modify(file, newContent);
				}

				totalConversions += fileConversionCount;

				processedFiles++;
				if (processedFiles % 10 === 0) {
					new Notice(`Processed ${processedFiles}/${files.length} files...`);
				}
			} catch (error) {
				log.error(`Error processing file ${file.path}:`, error);
				new Notice(`Error processing file ${file.path}: ${error.message}`);
			}
		}

		log.info(`Batch conversion complete: ${totalConversions} image(s) converted, ${filesWithBase64} file(s) contained base64, ${files.length} total files scanned`);
		new Notice(`Completed! Converted ${totalConversions} base64 image${totalConversions !== 1 ? 's' : ''} across ${files.length} files.`);
	}
}

class ConvertBase64ToPNGSettingTab extends PluginSettingTab {
	plugin: ConvertBase64ToPNGPlugin;

	constructor(app: App, plugin: ConvertBase64ToPNGPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Folder where PNG files will be saved (relative to the note)')
			.addText(text => text
				.setPlaceholder('attachments')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto convert')
			.setDesc('Automatically convert base64 images when pasting')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoConvert)
				.onChange(async (value) => {
					this.plugin.settings.autoConvert = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable debug logging to a file in the plugin directory')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Filename format')
			.setDesc('Format for generated filenames. Available placeholders: {{date}}, {{index}}, {{type}}')
			.addText(text => text
				.setPlaceholder('image-{{date}}-{{index}}')
				.setValue(this.plugin.settings.filenameFormat)
				.onChange(async (value) => {
					this.plugin.settings.filenameFormat = value;
					await this.plugin.saveSettings();
				}));

		// Sponsor section
		containerEl.createEl('hr');

		const sponsorDiv = containerEl.createDiv('sponsor-container');

		const sponsorText = sponsorDiv.createDiv('sponsor-text');
		sponsorText.setText('If you like this Plugin, consider donating to support continued development.');

		const buttonsDiv = sponsorDiv.createDiv('sponsor-buttons');

		// Ko-fi button
		const kofiLink = buttonsDiv.createEl('a', {
			href: 'https://ko-fi.com/nykkolin'
		});
		kofiLink.setAttribute('target', '_blank');
		kofiLink.setAttribute('rel', 'noopener');

		// Embed SVG directly instead of using external file
		kofiLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="38" viewBox="0 0 82.25 28" role="img" aria-label="KO-FI" class="sponsor-image"><title>KO-FI</title><g shape-rendering="crispEdges"><rect width="82.25" height="28" fill="#f16061"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100"><image x="9" y="7" width="14" height="14" href="data:image/svg+xml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgcm9sZT0iaW1nIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPktvLWZpPC90aXRsZT48cGF0aCBkPSJNMTEuMzUxIDIuNzE1Yy0yLjcgMC00Ljk4Ni4wMjUtNi44My4yNkMyLjA3OCAzLjI4NSAwIDUuMTU0IDAgOC42MWMwIDMuNTA2LjE4MiA2LjEzIDEuNTg1IDguNDkzIDEuNTg0IDIuNzAxIDQuMjMzIDQuMTgyIDcuNjYyIDQuMTgyaC44M2M0LjIwOSAwIDYuNDk0LTIuMjM0IDcuNjM3LTRhOS41IDkuNSAwIDAgMCAxLjA5MS0yLjMzOEMyMS43OTIgMTQuNjg4IDI0IDEyLjIyIDI0IDkuMjA4di0uNDE1YzAtMy4yNDctMi4xMy01LjUwNy01Ljc5Mi01Ljg3LTEuNTU4LS4xNTYtMi42NS0uMjA4LTYuODU3LS4yMDhtMCAxLjk0N2M0LjIwOCAwIDUuMDkuMDUyIDYuNTcxLjE4MiAyLjYyNC4zMTEgNC4xMyAxLjU4NCA0LjEzIDR2LjM5YzAgMi4xNTYtMS43OTIgMy44NDQtMy44NyAzLjg0NGgtLjkzNWwtLjE1Ni42NDljLS4yMDggMS4wMTMtLjU5NyAxLjgxOC0xLjAzOSAyLjU0Ni0uOTA5IDEuNDI4LTIuNTQ1IDMuMDY0LTUuOTIyIDMuMDY0aC0uODA1Yy0yLjU3MSAwLTQuODMxLS44ODMtNi4wNzgtMy4xOTUtMS4wOS0yLTEuMjk4LTQuMTU1LTEuMjk4LTcuNTA2IDAtMi4xODEuODU3LTMuNDAyIDMuMDEyLTMuNzE0IDEuNTMzLS4yMzMgMy41NTktLjI2IDYuMzktLjI2bTYuNTQ3IDIuMjg3Yy0uNDE2IDAtLjY1LjIzNC0uNjUuNTQ2djIuOTM1YzAgLjMxMS4yMzQuNTQ1LjY1LjU0NSAxLjMyNCAwIDIuMDUxLS43NTQgMi4wNTEtMnMtLjcyNy0yLjAyNi0yLjA1Mi0yLjAyNm0tMTAuMzkuMTgyYy0xLjgxOCAwLTMuMDEzIDEuNDgtMy4wMTMgMy4xNDIgMCAxLjUzMy44NTggMi44NTcgMS45NDkgMy44OTcuNzI3LjcwMSAxLjg3IDEuNDI5IDIuNjQ5IDEuODk2YTEuNDcgMS40NyAwIDAgMCAxLjUwNyAwYy43OC0uNDY3IDEuOTIyLTEuMTk1IDIuNjIzLTEuODk2IDEuMTE3LTEuMDM5IDEuOTc0LTIuMzY0IDEuOTc0LTMuODk3IDAtMS42NjItMS4yNDctMy4xNDItMy4wMzktMy4xNDItMS4wNjUgMC0xLjc5Mi41NDUtMi4zMzggMS4yOTgtLjQ5My0uNzUzLTEuMjQ2LTEuMjk4LTIuMzEyLTEuMjk4Ii8+PC9zdmc+"/><text transform="scale(.1)" x="511.25" y="175" textLength="382.5" fill="#fff" font-weight="bold">KO-FI</text></g></svg>`;

		// Buy Me a Coffee button
		const bmcLink = buttonsDiv.createEl('a', {
			href: 'https://www.buymeacoffee.com/xmasterdev'
		});
		bmcLink.setAttribute('target', '_blank');
		bmcLink.setAttribute('rel', 'noopener');

		// Embed SVG directly instead of using external file
		bmcLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="38" viewBox="0 0 217 60" class="sponsor-image">
  <!-- Background -->
  <rect width="217" height="60" rx="12" fill="#FFDD00"/>
  <!-- Coffee cup emoji -->
  <text x="19" y="42" font-size="30">☕️</text>
  <!-- "Buy me a coffee" text -->
  <text x="59" y="39" font-family="'Brush Script MT', 'Comic Sans MS', cursive" font-size="28" font-weight="normal" fill="#000000" font-style="italic">Buy me a coffee</text>
</svg>`;
	}
}
