import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ImageCommentsViewProvider(context);
	provider.openImageView();
}

export function deactivate() {}

/**
 * Image Entry
 */
interface ImageRef
{
	line: number,
	title: string | undefined,
	path: string | undefined
}

/**
 * Webview communtication packet.
 */
interface MessagePayload 
{
	type: 'openImageFile',
	value: any
}

/**
 * WebView Provider for the side panel.
 */
class ImageCommentsViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'imagecomments.imageView';

	/**
	 * Accepted image formats. 
	 * svg is potentially dangerous if embedded but it is secure if is used as src in an img tag. So it is supported here.
	 */
	private static readonly _acceptedImageFormats = /.*\.(png|jpeg|jpg|svg)$/i;

	/**
	 * Annotation patern 
	 * Example: @img ![ title ]( local rel path ) 
	 */
	private static readonly _commentPattern = /@img\s*!\[([^\]]*)\]\s*\(([^\)]+)/;

	/** Side panel */
	private _view?: vscode.WebviewView;

	/** Image index */
	private _images: ImageRef[] = [];

	/**
	 * Entry Point.
	 * @param _context 
	 */
	constructor(private readonly _context: vscode.ExtensionContext) {

		const provider = this;

		_context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(ImageCommentsViewProvider.viewType, provider)
		);
	
		_context.subscriptions.push(
			vscode.commands.registerCommand('imagecomments.openImageView', () => {
				provider.openImageView();
			})
		);
	
		_context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection(event => {
				provider._updateImageView();
			})
		);
	
		_context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument(event => {
				provider._reindex();
				//provider._updateImageView();
			})
		);
	
		_context.subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(event => {
				provider._reindex();
				provider._updateImageView();
			})
		);
	
		_context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(event => {
				provider._reindex();
				provider._updateImageView();
			})
		);
	}

	/**
	 * API Hook for the Panel View.
	 */
	public resolveWebviewView(webviewView: vscode.WebviewView, _: vscode.WebviewViewResolveContext, __: vscode.CancellationToken) 
	{
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true, // HTML used here is only internal.
		};

		webviewView.webview.onDidReceiveMessage(this._onDidReceiveMessage, this, this._context.subscriptions);		
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		this._view.show?.(true);

		this._reindex();
		this._updateImageView();
	}

	/**
	 * Activates the Side Panel View
	 */
	public openImageView() 
	{
		if (this._view) {
			this._view.show?.(true);
		}
	}

	/**
	 * Process action calls from the Side Panel.
	 * @param data 
	 */
	private _onDidReceiveMessage(data : MessagePayload)
	{
		switch (data.type) {
			case 'openImageFile':
				{
					//console.log(`Message: ${data.type}, ${data.value}`);
					this._openImage(data.value);
					break;
				}
			default:
				{
					console.log(`No Action: ${data.type}`);
					break;
				}
		}
	}

	/**
	 * Launch an editor like panel with the image for better view.
	 * @param imageUri 
	 */
	private _openImage(imageUri : string) 
	{
		const panel = vscode.window.createWebviewPanel(
			"ImagePreviewPanel",
			'img: ' + path.basename(imageUri),
			vscode.ViewColumn.One,
			{enableScripts: false},
		);
		const uri = panel.webview.asWebviewUri(vscode.Uri.file(imageUri));
		panel.webview.html = this._renderHtml(this._getStyle(true), `<img src="${uri}" />`);
		if (this._view) {
			this._view.webview.html = this._getHtmlForWebview(this._view.webview);
		}
	}

	/**
	 * Find the path in current folder and parents up to workspace folder.
	 * @param imageRef 
	 * @returns 
	 */
	private _getImageRefPath(imageRef: ImageRef) : vscode.Uri | undefined 
	{
		if (!vscode.window.activeTextEditor || !this._view || !imageRef.path) {
			return undefined;
		}
		if (!imageRef.path.match(ImageCommentsViewProvider._acceptedImageFormats)) {
			return undefined;
		}
		const documentUri = vscode.window.activeTextEditor.document.uri;
		var folder = vscode.workspace.getWorkspaceFolder(documentUri);
		while (folder) {
			let file = path.join(folder.uri.fsPath, imageRef.path);
			if (fs.existsSync(file)) {
				return vscode.Uri.file(file);
			}
			folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.dirname(folder.uri.fsPath)));
		}
	}

	/**
	 * Reload Html content, show closest ImageRef from current line to the document start.
	 */
	private _updateImageView() {
		if (!vscode.window.activeTextEditor || !this._view) {
			return;
		}

		const webview = this._view.webview;
		if (this._images.length > 0) {
			const currentLine = vscode.window.activeTextEditor.selection.active.line;
			for (const imageRef of this._images) {
				if (imageRef.line <= currentLine) {
					webview.html = this._getHtmlForWebview(webview, imageRef);
					return;
				}
			}
			webview.html = this._getHtmlForWebview(webview, this._images[this._images.length - 1]);
		}
		else {
			webview.html = this._getHtmlForWebview(webview);
		}
	}

	/**
	 * Scan the active document and create an index of image references.
	 */
	private _reindex() {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			return;
		}
		const pattern = ImageCommentsViewProvider._commentPattern;
		this._images = [];
		if (activeEditor) {
			const text = activeEditor.document.getText().split("\n");
			for (let i = text.length - 1; i >= 0; --i) {
				let m = pattern.exec(text[i]);
				if (m) {
					this._images.push({line: i, title: m[1], path: m[2]});
				}
			}
		}
	}

	/**
	 * Embedded Javascript generator
	 * @returns 
	 */
	private _getJsScript()
	{
		return `<script type="text/javascript">
			(function () {
				const vscode = acquireVsCodeApi();
				document.querySelector('#imageView').addEventListener('click', (event) => {
					const file = event.target.dataset.file;
					if (file) {
						vscode.postMessage({ type: 'openImageFile', value: file });
					}
				});
			}());					
		</script>`;
	}

	/**
	 * Embedded css generator
	 * @param hasContent 
	 * @returns 
	 */
	private _getStyle(hasContent : boolean) 
	{
		const body = hasContent ? "color: #000000; background: #fefefe;" : "";
		return `<style>
			#title {
				position:fixed; 
				top:0; 
				width:100%; 
				background: #fefefe; 
				border-bottom: 1px solid; 
				padding: 3px;
			}
			#footer {
				position:fixed; 
				bottom:0; 
				width:100%; 
				background: #fefefe; 
				border-top: 1px solid; 
				padding-bottom: 7px;
			}
			#imageView {
				margin-top: 24px; 
				margin-bottom: 100px;						
			}
			body {
				${body}
			}
		</style>`;
	}

	/**
	 * Main HTML Template
	 * @param style 
	 * @param body 
	 * @returns 
	 */
	private _renderHtml(style: string, body: string)
	{
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<title>Image Comments</title>
				${style}
			</head>
			<body>
				${body}
			</body>
			</html>`;
	}

	/**
	 * HTML Content generator for an ImageRef
	 * @param webview 
	 * @param imageRef 
	 * @returns 
	 */
	private _getHtmlForWebview(webview: vscode.Webview, imageRef? : ImageRef) {
		let html = "";
		if (imageRef && imageRef.path) {
			let path = this._getImageRefPath(imageRef);
			if (path) {
				const uri = webview.asWebviewUri(path);
				const relPath = vscode.workspace.asRelativePath(path);
				const scriptTag = this._getJsScript();
				html = `
					<div id="title">line ${imageRef.line+1}: ${imageRef.title ? imageRef.title : relPath}</div>
					<img id="imageView" src="${uri}" data-file="${path.fsPath}" />
					<div id="footer">${relPath}</div>
					${scriptTag}
					`;
			}
		}
		const style = this._getStyle(html.length !== 0);
		return this._renderHtml(style, html);
	}
}

