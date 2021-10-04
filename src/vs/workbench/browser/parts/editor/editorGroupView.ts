/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/editorgroupview';
import { EditorGroupModel, IEditorOpenOptions, ISerializedEditorGroupModel, isSerializedEditorGroupModel } from 'vs/workbench/common/editor/editorGroupModel';
import { GroupIdentifier, CloseDirection, IEditorCloseEvent, ActiveEditorDirtyContext, IEditorPane, EditorGroupEditorsCountContext, SaveReason, IEditorPartOptionsChangeEvent, EditorsOrder, IVisibleEditorPane, ActiveEditorStickyContext, ActiveEditorPinnedContext, EditorResourceAccessor, IEditorMoveEvent, EditorInputCapabilities, IEditorOpenEvent, IUntypedEditorInput, DEFAULT_EDITOR_ASSOCIATION, ActiveEditorGroupLockedContext, SideBySideEditor, EditorCloseContext, IEditorWillMoveEvent, IEditorWillOpenEvent } from 'vs/workbench/common/editor';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { SideBySideEditorInput } from 'vs/workbench/common/editor/sideBySideEditorInput';
import { Event, Emitter, Relay } from 'vs/base/common/event';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Dimension, trackFocus, addDisposableListener, EventType, EventHelper, findParentWithClass, clearNode, isAncestor, asCSSUrl } from 'vs/base/browser/dom';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { attachProgressBarStyler } from 'vs/platform/theme/common/styler';
import { IThemeService, registerThemingParticipant, Themable } from 'vs/platform/theme/common/themeService';
import { editorBackground, contrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { EDITOR_GROUP_HEADER_TABS_BACKGROUND, EDITOR_GROUP_HEADER_NO_TABS_BACKGROUND, EDITOR_GROUP_EMPTY_BACKGROUND, EDITOR_GROUP_FOCUSED_EMPTY_BORDER, EDITOR_GROUP_HEADER_BORDER } from 'vs/workbench/common/theme';
import { ICloseEditorsFilter, IGroupChangeEvent, GroupChangeKind, GroupsOrder, ICloseEditorOptions, ICloseAllEditorsOptions, IEditorReplacement } from 'vs/workbench/services/editor/common/editorGroupsService';
import { TabsTitleControl } from 'vs/workbench/browser/parts/editor/tabsTitleControl';
import { EditorPanes } from 'vs/workbench/browser/parts/editor/editorPanes';
import { IEditorProgressService } from 'vs/platform/progress/common/progress';
import { EditorProgressIndicator } from 'vs/workbench/services/progress/browser/progressIndicator';
import { localize } from 'vs/nls';
import { coalesce, firstOrDefault } from 'vs/base/common/arrays';
import { isErrorWithActions, isPromiseCanceledError } from 'vs/base/common/errors';
import { combinedDisposable, dispose, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { Severity, INotificationService } from 'vs/platform/notification/common/notification';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { Promises, RunOnceWorker } from 'vs/base/common/async';
import { EventType as TouchEventType, GestureEvent } from 'vs/base/browser/touch';
import { TitleControl } from 'vs/workbench/browser/parts/editor/titleControl';
import { IEditorGroupsAccessor, IEditorGroupView, fillActiveEditorViewState, EditorServiceImpl, IEditorGroupTitleHeight, IInternalEditorOpenOptions, IInternalMoveCopyOptions, IInternalEditorCloseOptions, IInternalEditorTitleControlOptions } from 'vs/workbench/browser/parts/editor/editor';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IAction } from 'vs/base/common/actions';
import { NoTabsTitleControl } from 'vs/workbench/browser/parts/editor/noTabsTitleControl';
import { IMenuService, MenuId, IMenu } from 'vs/platform/actions/common/actions';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { createAndFillInActionBarActions, createAndFillInContextMenuActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { hash } from 'vs/base/common/hash';
import { guessMimeTypes } from 'vs/base/common/mime';
import { extname, isEqual } from 'vs/base/common/resources';
import { FileAccess, Schemas } from 'vs/base/common/network';
import { EditorActivation, EditorOpenContext, IEditorOptions } from 'vs/platform/editor/common/editor';
import { IDialogService, IFileDialogService, ConfirmResult } from 'vs/platform/dialogs/common/dialogs';
import { ILogService } from 'vs/platform/log/common/log';
import { IFilesConfigurationService, AutoSaveMode } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { IUriIdentityService } from 'vs/workbench/services/uriIdentity/common/uriIdentity';
import { isLinux, isNative, isWindows } from 'vs/base/common/platform';

export class EditorGroupView extends Themable implements IEditorGroupView {

	//#region factory

	static createNew(accessor: IEditorGroupsAccessor, index: number, instantiationService: IInstantiationService): IEditorGroupView {
		return instantiationService.createInstance(EditorGroupView, accessor, null, index);
	}

	static createFromSerialized(serialized: ISerializedEditorGroupModel, accessor: IEditorGroupsAccessor, index: number, instantiationService: IInstantiationService): IEditorGroupView {
		return instantiationService.createInstance(EditorGroupView, accessor, serialized, index);
	}

	static createCopy(copyFrom: IEditorGroupView, accessor: IEditorGroupsAccessor, index: number, instantiationService: IInstantiationService): IEditorGroupView {
		return instantiationService.createInstance(EditorGroupView, accessor, copyFrom, index);
	}

	//#endregion

	/**
	 * Access to the context key service scoped to this editor group.
	 */
	readonly scopedContextKeyService: IContextKeyService;

	//#region events

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus = this._onDidFocus.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	private readonly _onDidGroupChange = this._register(new Emitter<IGroupChangeEvent>());
	readonly onDidGroupChange = this._onDidGroupChange.event;

	private readonly _onDidOpenEditorFail = this._register(new Emitter<EditorInput>());
	readonly onDidOpenEditorFail = this._onDidOpenEditorFail.event;

	private readonly _onWillCloseEditor = this._register(new Emitter<IEditorCloseEvent>());
	readonly onWillCloseEditor = this._onWillCloseEditor.event;

	private readonly _onDidCloseEditor = this._register(new Emitter<IEditorCloseEvent>());
	readonly onDidCloseEditor = this._onDidCloseEditor.event;

	private readonly _onWillMoveEditor = this._register(new Emitter<IEditorWillMoveEvent>());
	readonly onWillMoveEditor = this._onWillMoveEditor.event;

	private readonly _onWillOpenEditor = this._register(new Emitter<IEditorWillOpenEvent>());
	readonly onWillOpenEditor = this._onWillOpenEditor.event;

	//#endregion

	private readonly model: EditorGroupModel;

	private active: boolean | undefined;
	private dimension: Dimension | undefined;

	private readonly scopedInstantiationService: IInstantiationService;

	private readonly titleContainer: HTMLElement;
	private titleAreaControl: TitleControl;

	private readonly progressBar: ProgressBar;

	private readonly editorContainer: HTMLElement;
	private readonly editorPane: EditorPanes;

	private readonly disposedEditorsWorker = this._register(new RunOnceWorker<EditorInput>(editors => this.handleDisposedEditors(editors), 0));

	private readonly mapEditorToPendingConfirmation = new Map<EditorInput, Promise<boolean>>();

	private readonly containerToolBarMenuDisposable = this._register(new MutableDisposable());

	private whenRestoredResolve: (() => void) | undefined;
	readonly whenRestored = new Promise<void>(resolve => (this.whenRestoredResolve = resolve));
	private isRestored = false;

	constructor(
		private accessor: IEditorGroupsAccessor,
		from: IEditorGroupView | ISerializedEditorGroupModel | null,
		private _index: number,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: EditorServiceImpl,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super(themeService);

		if (from instanceof EditorGroupView) {
			this.model = this._register(from.model.clone());
		} else if (isSerializedEditorGroupModel(from)) {
			this.model = this._register(instantiationService.createInstance(EditorGroupModel, from));
		} else {
			this.model = this._register(instantiationService.createInstance(EditorGroupModel, undefined));
		}

		//#region create()
		{
			// Scoped context key service
			this.scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.element));

			// Container
			this.element.classList.add('editor-group-container');

			// Container listeners
			this.registerContainerListeners();

			// Container toolbar
			this.createContainerToolbar();

			// Container context menu
			this.createContainerContextMenu();

			// Letterpress container
			const letterpressContainer = document.createElement('div');
			letterpressContainer.classList.add('editor-group-letterpress');
			this.element.appendChild(letterpressContainer);

			// Progress bar
			this.progressBar = this._register(new ProgressBar(this.element));
			this._register(attachProgressBarStyler(this.progressBar, this.themeService));
			this.progressBar.hide();

			// Scoped instantiation service
			this.scopedInstantiationService = this.instantiationService.createChild(new ServiceCollection(
				[IContextKeyService, this.scopedContextKeyService],
				[IEditorProgressService, this._register(new EditorProgressIndicator(this.progressBar, this))]
			));

			// Context keys
			this.handleGroupContextKeys();

			// Title container
			this.titleContainer = document.createElement('div');
			this.titleContainer.classList.add('title');
			this.element.appendChild(this.titleContainer);

			// Title control
			this.titleAreaControl = this.createTitleAreaControl();

			// Editor container
			this.editorContainer = document.createElement('div');
			this.editorContainer.classList.add('editor-container');
			this.element.appendChild(this.editorContainer);

			// Editor pane
			this.editorPane = this._register(this.scopedInstantiationService.createInstance(EditorPanes, this.editorContainer, this));
			this._onDidChange.input = this.editorPane.onDidChangeSizeConstraints;

			// Track Focus
			this.doTrackFocus();

			// Update containers
			this.updateTitleContainer();
			this.updateContainer();

			// Update styles
			this.updateStyles();
		}
		//#endregion

		// Restore editors if provided
		const restoreEditorsPromise = this.restoreEditors(from) ?? Promise.resolve();

		// Signal restored once editors have restored
		restoreEditorsPromise.finally(() => {
			this.isRestored = true;
			this.whenRestoredResolve?.();
		});

		// Register Listeners
		this.registerListeners();
	}

	private handleGroupContextKeys(): void {
		const groupActiveEditorDirtyContext = ActiveEditorDirtyContext.bindTo(this.scopedContextKeyService);
		const groupActiveEditorPinnedContext = ActiveEditorPinnedContext.bindTo(this.scopedContextKeyService);
		const groupActiveEditorStickyContext = ActiveEditorStickyContext.bindTo(this.scopedContextKeyService);
		const groupEditorsCountContext = EditorGroupEditorsCountContext.bindTo(this.scopedContextKeyService);
		const groupLockedContext = ActiveEditorGroupLockedContext.bindTo(this.scopedContextKeyService);

		const activeEditorListener = new MutableDisposable();

		const observeActiveEditor = () => {
			activeEditorListener.clear();

			const activeEditor = this.model.activeEditor;
			if (activeEditor) {
				groupActiveEditorDirtyContext.set(activeEditor.isDirty() && !activeEditor.isSaving());
				activeEditorListener.value = activeEditor.onDidChangeDirty(() => {
					groupActiveEditorDirtyContext.set(activeEditor.isDirty() && !activeEditor.isSaving());
				});
			} else {
				groupActiveEditorDirtyContext.set(false);
			}
		};

		// Update group contexts based on group changes
		this._register(this.onDidGroupChange(e => {
			switch (e.kind) {
				case GroupChangeKind.EDITOR_ACTIVE:
					// Track the active editor and update context key that reflects
					// the dirty state of this editor
					observeActiveEditor();
					break;
				case GroupChangeKind.EDITOR_PIN:
					if (e.editor && e.editor === this.model.activeEditor) {
						groupActiveEditorPinnedContext.set(this.model.isPinned(this.model.activeEditor));
					}
					break;
				case GroupChangeKind.EDITOR_STICKY:
					if (e.editor && e.editor === this.model.activeEditor) {
						groupActiveEditorStickyContext.set(this.model.isSticky(this.model.activeEditor));
					}
					break;
				case GroupChangeKind.GROUP_LOCKED:
					groupLockedContext.set(this.isLocked);
					break;
			}

			// Group editors count context
			groupEditorsCountContext.set(this.count);
		}));

		observeActiveEditor();
	}

	private registerContainerListeners(): void {

		// Open new file via doubleclick on empty container
		this._register(addDisposableListener(this.element, EventType.DBLCLICK, e => {
			if (this.isEmpty) {
				EventHelper.stop(e);

				this.editorService.openEditor({
					resource: undefined,
					options: {
						pinned: true,
						override: DEFAULT_EDITOR_ASSOCIATION.id
					}
				}, this.id);
			}
		}));

		// Close empty editor group via middle mouse click
		this._register(addDisposableListener(this.element, EventType.AUXCLICK, e => {
			if (this.isEmpty && e.button === 1 /* Middle Button */) {
				EventHelper.stop(e, true);

				this.accessor.removeGroup(this);
			}
		}));
	}

	private createContainerToolbar(): void {

		// Toolbar Container
		const toolbarContainer = document.createElement('div');
		toolbarContainer.classList.add('editor-group-container-toolbar');
		this.element.appendChild(toolbarContainer);

		// Toolbar
		const containerToolbar = this._register(new ActionBar(toolbarContainer, {
			ariaLabel: localize('ariaLabelGroupActions', "Empty editor group actions")
		}));

		// Toolbar actions
		const containerToolbarMenu = this._register(this.menuService.createMenu(MenuId.EmptyEditorGroup, this.scopedContextKeyService));
		const updateContainerToolbar = () => {
			const actions: { primary: IAction[], secondary: IAction[] } = { primary: [], secondary: [] };

			this.containerToolBarMenuDisposable.value = combinedDisposable(

				// Clear old actions
				toDisposable(() => containerToolbar.clear()),

				// Create new actions
				createAndFillInActionBarActions(
					containerToolbarMenu,
					{ arg: { groupId: this.id }, shouldForwardArgs: true },
					actions,
					'navigation'
				)
			);

			for (const action of [...actions.primary, ...actions.secondary]) {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				containerToolbar.push(action, { icon: true, label: false, keybinding: keybinding?.getLabel() });
			}
		};
		updateContainerToolbar();
		this._register(containerToolbarMenu.onDidChange(updateContainerToolbar));
	}

	private createContainerContextMenu(): void {
		const menu = this._register(this.menuService.createMenu(MenuId.EmptyEditorGroupContext, this.contextKeyService));

		this._register(addDisposableListener(this.element, EventType.CONTEXT_MENU, e => this.onShowContainerContextMenu(menu, e)));
		this._register(addDisposableListener(this.element, TouchEventType.Contextmenu, () => this.onShowContainerContextMenu(menu)));
	}

	private onShowContainerContextMenu(menu: IMenu, e?: MouseEvent): void {
		if (!this.isEmpty) {
			return; // only for empty editor groups
		}

		// Find target anchor
		let anchor: HTMLElement | { x: number, y: number } = this.element;
		if (e instanceof MouseEvent) {
			const event = new StandardMouseEvent(e);
			anchor = { x: event.posx, y: event.posy };
		}

		// Fill in contributed actions
		const actions: IAction[] = [];
		const actionsDisposable = createAndFillInContextMenuActions(menu, undefined, actions);

		// Show it
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => {
				this.focus();
				dispose(actionsDisposable);
			}
		});
	}

	private doTrackFocus(): void {

		// Container
		const containerFocusTracker = this._register(trackFocus(this.element));
		this._register(containerFocusTracker.onDidFocus(() => {
			if (this.isEmpty) {
				this._onDidFocus.fire(); // only when empty to prevent accident focus
			}
		}));

		// Title Container
		const handleTitleClickOrTouch = (e: MouseEvent | GestureEvent): void => {
			let target: HTMLElement;
			if (e instanceof MouseEvent) {
				if (e.button !== 0) {
					return undefined; // only for left mouse click
				}

				target = e.target as HTMLElement;
			} else {
				target = (e as GestureEvent).initialTarget as HTMLElement;
			}

			if (findParentWithClass(target, 'monaco-action-bar', this.titleContainer) ||
				findParentWithClass(target, 'monaco-breadcrumb-item', this.titleContainer)
			) {
				return; // not when clicking on actions or breadcrumbs
			}

			// timeout to keep focus in editor after mouse up
			setTimeout(() => {
				this.focus();
			});
		};

		this._register(addDisposableListener(this.titleContainer, EventType.MOUSE_DOWN, e => handleTitleClickOrTouch(e)));
		this._register(addDisposableListener(this.titleContainer, TouchEventType.Tap, e => handleTitleClickOrTouch(e)));

		// Editor pane
		this._register(this.editorPane.onDidFocus(() => {
			this._onDidFocus.fire();
		}));
	}

	private updateContainer(): void {

		// Empty Container: add some empty container attributes
		if (this.isEmpty) {
			this.element.classList.add('empty');
			this.element.tabIndex = 0;
			this.element.setAttribute('aria-label', localize('emptyEditorGroup', "{0} (empty)", this.label));
		}

		// Non-Empty Container: revert empty container attributes
		else {
			this.element.classList.remove('empty');
			this.element.removeAttribute('tabIndex');
			this.element.removeAttribute('aria-label');
		}

		// Update styles
		this.updateStyles();
	}

	private updateTitleContainer(): void {
		this.titleContainer.classList.toggle('tabs', this.accessor.partOptions.showTabs);
		this.titleContainer.classList.toggle('show-file-icons', this.accessor.partOptions.showIcons);
	}

	private createTitleAreaControl(): TitleControl {

		// Clear old if existing
		if (this.titleAreaControl) {
			this.titleAreaControl.dispose();
			clearNode(this.titleContainer);
		}

		// Create new based on options
		if (this.accessor.partOptions.showTabs) {
			this.titleAreaControl = this.scopedInstantiationService.createInstance(TabsTitleControl, this.titleContainer, this.accessor, this);
		} else {
			this.titleAreaControl = this.scopedInstantiationService.createInstance(NoTabsTitleControl, this.titleContainer, this.accessor, this);
		}

		return this.titleAreaControl;
	}

	private restoreEditors(from: IEditorGroupView | ISerializedEditorGroupModel | null): Promise<void> | undefined {
		if (this.count === 0) {
			return; // nothing to show
		}

		// Determine editor options
		let options: IEditorOptions;
		if (from instanceof EditorGroupView) {
			options = fillActiveEditorViewState(from); // if we copy from another group, ensure to copy its active editor viewstate
		} else {
			options = Object.create(null);
		}

		const activeEditor = this.model.activeEditor;
		if (!activeEditor) {
			return;
		}

		options.pinned = this.model.isPinned(activeEditor);	// preserve pinned state
		options.sticky = this.model.isSticky(activeEditor);	// preserve sticky state
		options.preserveFocus = true;						// handle focus after editor is opened

		const activeElement = document.activeElement;

		// Show active editor (intentionally not using async to keep
		// `restoreEditors` from executing in same stack)
		return this.doShowEditor(activeEditor, { active: true, isNew: false /* restored */ }, options).then(() => {

			// Set focused now if this is the active group and focus has
			// not changed meanwhile. This prevents focus from being
			// stolen accidentally on startup when the user already
			// clicked somewhere.
			if (this.accessor.activeGroup === this && activeElement === document.activeElement) {
				this.focus();
			}
		});
	}

	//#region event handling

	private registerListeners(): void {

		// Model Events
		this._register(this.model.onDidChangeLocked(() => this.onDidChangeGroupLocked()));
		this._register(this.model.onDidChangeEditorPinned(editor => this.onDidChangeEditorPinned(editor)));
		this._register(this.model.onDidChangeEditorSticky(editor => this.onDidChangeEditorSticky(editor)));
		this._register(this.model.onDidMoveEditor(event => this.onDidMoveEditor(event)));
		this._register(this.model.onDidOpenEditor(editor => this.onDidOpenEditor(editor)));
		this._register(this.model.onDidCloseEditor(editor => this.handleOnDidCloseEditor(editor)));
		this._register(this.model.onWillDisposeEditor(editor => this.onWillDisposeEditor(editor)));
		this._register(this.model.onDidChangeEditorDirty(editor => this.onDidChangeEditorDirty(editor)));
		this._register(this.model.onDidChangeEditorLabel(editor => this.onDidChangeEditorLabel(editor)));
		this._register(this.model.onDidChangeEditorCapabilities(editor => this.onDidChangeEditorCapabilities(editor)));

		// Option Changes
		this._register(this.accessor.onDidChangeEditorPartOptions(e => this.onDidChangeEditorPartOptions(e)));

		// Visibility
		this._register(this.accessor.onDidVisibilityChange(e => this.onDidVisibilityChange(e)));
	}

	private onDidChangeGroupLocked(): void {
		this._onDidGroupChange.fire({ kind: GroupChangeKind.GROUP_LOCKED });
	}

	private onDidChangeEditorPinned(editor: EditorInput): void {
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_PIN, editor });
	}

	private onDidChangeEditorSticky(editor: EditorInput): void {
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_STICKY, editor });
	}

	private onDidMoveEditor({ editor, index, newIndex }: IEditorMoveEvent): void {
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_MOVE, editor, oldEditorIndex: index, editorIndex: newIndex });
	}

	private onDidOpenEditor({ editor, index }: IEditorOpenEvent): void {

		/* __GDPR__
			"editorOpened" : {
				"${include}": [
					"${EditorTelemetryDescriptor}"
				]
			}
		*/
		this.telemetryService.publicLog('editorOpened', this.toEditorTelemetryDescriptor(editor));

		// Update container
		this.updateContainer();

		// Event
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_OPEN, editor, editorIndex: index });
	}

	private handleOnDidCloseEditor(event: IEditorCloseEvent): void {

		// Before close
		this._onWillCloseEditor.fire(event);

		// Handle event
		const editor = event.editor;
		const editorsToClose: EditorInput[] = [editor];

		// Include both sides of side by side editors when being closed
		if (editor instanceof SideBySideEditorInput) {
			editorsToClose.push(editor.primary, editor.secondary);
		}

		// For each editor to close, we call dispose() to free up any resources.
		// However, certain editors might be shared across multiple editor groups
		// (including being visible in side by side / diff editors) and as such we
		// only dispose when they are not opened elsewhere.
		for (const editor of editorsToClose) {
			if (this.canDispose(editor)) {
				editor.dispose();
			}
		}

		/* __GDPR__
			"editorClosed" : {
				"${include}": [
					"${EditorTelemetryDescriptor}"
				]
			}
		*/
		this.telemetryService.publicLog('editorClosed', this.toEditorTelemetryDescriptor(event.editor));

		// Update container
		this.updateContainer();

		// Event
		this._onDidCloseEditor.fire(event);
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_CLOSE, editor, editorIndex: event.index });
	}

	private canDispose(editor: EditorInput): boolean {
		for (const groupView of this.accessor.groups) {
			if (groupView instanceof EditorGroupView && groupView.model.contains(editor, {
				strictEquals: true,						// only if this input is not shared across editor groups
				supportSideBySide: SideBySideEditor.ANY // include any side of an opened side by side editor
			})) {
				return false;
			}
		}

		return true;
	}

	private toEditorTelemetryDescriptor(editor: EditorInput): object {
		const descriptor = editor.getTelemetryDescriptor();

		const resource = EditorResourceAccessor.getOriginalUri(editor);
		const path = resource ? resource.scheme === Schemas.file ? resource.fsPath : resource.path : undefined;
		if (resource && path) {
			let resourceExt = extname(resource);
			// Remove query parameters from the resource extension
			const queryStringLocation = resourceExt.indexOf('?');
			resourceExt = queryStringLocation !== -1 ? resourceExt.substr(0, queryStringLocation) : resourceExt;
			descriptor['resource'] = { mimeType: guessMimeTypes(resource).join(', '), scheme: resource.scheme, ext: resourceExt, path: hash(path) };

			/* __GDPR__FRAGMENT__
				"EditorTelemetryDescriptor" : {
					"resource": { "${inline}": [ "${URIDescriptor}" ] }
				}
			*/
			return descriptor;
		}

		return descriptor;
	}

	private onWillDisposeEditor(editor: EditorInput): void {

		// To prevent race conditions, we handle disposed editors in our worker with a timeout
		// because it can happen that an input is being disposed with the intent to replace
		// it with some other input right after.
		this.disposedEditorsWorker.work(editor);
	}

	private handleDisposedEditors(editors: EditorInput[]): void {

		// Split between visible and hidden editors
		let activeEditor: EditorInput | undefined;
		const inactiveEditors: EditorInput[] = [];
		for (const editor of editors) {
			if (this.model.isActive(editor)) {
				activeEditor = editor;
			} else if (this.model.contains(editor)) {
				inactiveEditors.push(editor);
			}
		}

		// Close all inactive editors first to prevent UI flicker
		for (const inactiveEditor of inactiveEditors) {
			this.doCloseEditor(inactiveEditor, false);
		}

		// Close active one last
		if (activeEditor) {
			this.doCloseEditor(activeEditor, false);
		}
	}

	private onDidChangeEditorPartOptions(event: IEditorPartOptionsChangeEvent): void {

		// Title container
		this.updateTitleContainer();

		// Title control Switch between showing tabs <=> not showing tabs
		if (event.oldPartOptions.showTabs !== event.newPartOptions.showTabs) {

			// Recreate title control
			this.createTitleAreaControl();

			// Re-layout
			this.relayout();

			// Ensure to show active editor if any
			if (this.model.activeEditor) {
				this.titleAreaControl.openEditor(this.model.activeEditor);
			}
		}

		// Just update title control
		else {
			this.titleAreaControl.updateOptions(event.oldPartOptions, event.newPartOptions);
		}

		// Styles
		this.updateStyles();

		// Pin preview editor once user disables preview
		if (event.oldPartOptions.enablePreview && !event.newPartOptions.enablePreview) {
			if (this.model.previewEditor) {
				this.pinEditor(this.model.previewEditor);
			}
		}
	}

	private onDidChangeEditorDirty(editor: EditorInput): void {

		// Always show dirty editors pinned
		this.pinEditor(editor);

		// Forward to title control
		this.titleAreaControl.updateEditorDirty(editor);

		// Event
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_DIRTY, editor });
	}

	private onDidChangeEditorLabel(editor: EditorInput): void {

		// Forward to title control
		this.titleAreaControl.updateEditorLabel(editor);

		// Event
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_LABEL, editor });
	}

	private onDidChangeEditorCapabilities(editor: EditorInput): void {

		// Event
		this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_CAPABILITIES, editor });
	}

	private onDidVisibilityChange(visible: boolean): void {

		// Forward to active editor pane
		this.editorPane.setVisible(visible);
	}

	//#endregion

	//#region IEditorGroupView

	get index(): number {
		return this._index;
	}

	get label(): string {
		return localize('groupLabel', "Group {0}", this._index + 1);
	}

	get ariaLabel(): string {
		return localize('groupAriaLabel', "Editor Group {0}", this._index + 1);
	}

	private _disposed = false;
	get disposed(): boolean {
		return this._disposed;
	}

	get isEmpty(): boolean {
		return this.count === 0;
	}

	get titleHeight(): IEditorGroupTitleHeight {
		return this.titleAreaControl.getHeight();
	}

	get isMinimized(): boolean {
		if (!this.dimension) {
			return false;
		}

		return this.dimension.width === this.minimumWidth || this.dimension.height === this.minimumHeight;
	}

	notifyIndexChanged(newIndex: number): void {
		if (this._index !== newIndex) {
			this._index = newIndex;
			this._onDidGroupChange.fire({ kind: GroupChangeKind.GROUP_INDEX });
		}
	}

	setActive(isActive: boolean): void {
		this.active = isActive;

		// Update container
		this.element.classList.toggle('active', isActive);
		this.element.classList.toggle('inactive', !isActive);

		// Update title control
		this.titleAreaControl.setActive(isActive);

		// Update styles
		this.updateStyles();

		// Event
		this._onDidGroupChange.fire({ kind: GroupChangeKind.GROUP_ACTIVE });
	}

	//#endregion

	//#region IEditorGroup

	//#region basics()

	get id(): GroupIdentifier {
		return this.model.id;
	}

	get editors(): EditorInput[] {
		return this.model.getEditors(EditorsOrder.SEQUENTIAL);
	}

	get count(): number {
		return this.model.count;
	}

	get stickyCount(): number {
		return this.model.stickyCount;
	}

	get activeEditorPane(): IVisibleEditorPane | undefined {
		return this.editorPane ? withNullAsUndefined(this.editorPane.activeEditorPane) : undefined;
	}

	get activeEditor(): EditorInput | null {
		return this.model.activeEditor;
	}

	get previewEditor(): EditorInput | null {
		return this.model.previewEditor;
	}

	isPinned(editor: EditorInput): boolean {
		return this.model.isPinned(editor);
	}

	isSticky(editorOrIndex: EditorInput | number): boolean {
		return this.model.isSticky(editorOrIndex);
	}

	isActive(editor: EditorInput | IUntypedEditorInput): boolean {
		return this.model.isActive(editor);
	}

	contains(candidate: EditorInput | IUntypedEditorInput): boolean {
		return this.model.contains(candidate);
	}

	getEditors(order: EditorsOrder, options?: { excludeSticky?: boolean }): EditorInput[] {
		return this.model.getEditors(order, options);
	}

	findEditors(resource: URI): EditorInput[] {
		const canonicalResource = this.uriIdentityService.asCanonicalUri(resource);
		return this.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => {
			return editor.resource && isEqual(editor.resource, canonicalResource);
		});
	}

	getEditorByIndex(index: number): EditorInput | undefined {
		return this.model.getEditorByIndex(index);
	}

	getIndexOfEditor(editor: EditorInput): number {
		return this.model.indexOf(editor);
	}

	focus(): void {

		// Pass focus to editor panes
		if (this.activeEditorPane) {
			this.activeEditorPane.focus();
		} else {
			this.element.focus();
		}

		// Event
		this._onDidFocus.fire();
	}

	pinEditor(candidate: EditorInput | undefined = this.activeEditor || undefined): void {
		if (candidate && !this.model.isPinned(candidate)) {

			// Update model
			const editor = this.model.pin(candidate);

			// Forward to title control
			if (editor) {
				this.titleAreaControl.pinEditor(editor);
			}
		}
	}

	stickEditor(candidate: EditorInput | undefined = this.activeEditor || undefined): void {
		this.doStickEditor(candidate, true);
	}

	unstickEditor(candidate: EditorInput | undefined = this.activeEditor || undefined): void {
		this.doStickEditor(candidate, false);
	}

	private doStickEditor(candidate: EditorInput | undefined, sticky: boolean): void {
		if (candidate && this.model.isSticky(candidate) !== sticky) {
			const oldIndexOfEditor = this.getIndexOfEditor(candidate);

			// Update model
			const editor = sticky ? this.model.stick(candidate) : this.model.unstick(candidate);
			if (!editor) {
				return;
			}

			// If the index of the editor changed, we need to forward this to
			// title control and also make sure to emit this as an event
			const newIndexOfEditor = this.getIndexOfEditor(editor);
			if (newIndexOfEditor !== oldIndexOfEditor) {
				this.titleAreaControl.moveEditor(editor, oldIndexOfEditor, newIndexOfEditor);
			}

			// Forward sticky state to title control
			if (sticky) {
				this.titleAreaControl.stickEditor(editor);
			} else {
				this.titleAreaControl.unstickEditor(editor);
			}
		}
	}

	//#endregion

	//#region openEditor()

	async openEditor(editor: EditorInput, options?: IEditorOptions): Promise<IEditorPane | undefined> {
		return this.doOpenEditor(editor, options, {
			// Allow to match on a side-by-side editor when same
			// editor is opened on both sides. In that case we
			// do not want to open a new editor but reuse that one.
			supportSideBySide: SideBySideEditor.BOTH
		});
	}

	private async doOpenEditor(editor: EditorInput, options?: IEditorOptions, internalOptions?: IInternalEditorOpenOptions): Promise<IEditorPane | undefined> {

		// Guard against invalid editors. Disposed editors
		// should never open because they emit no events
		// e.g. to indicate dirty changes.
		if (!editor || editor.isDisposed()) {
			return;
		}

		// Fire the event letting everyone know we are about to open an editor
		this._onWillOpenEditor.fire({ editor, groupId: this.id });

		// Determine options
		const openEditorOptions: IEditorOpenOptions = {
			index: options ? options.index : undefined,
			pinned: options?.sticky || !this.accessor.partOptions.enablePreview || editor.isDirty() || (options?.pinned ?? typeof options?.index === 'number' /* unless specified, prefer to pin when opening with index */) || (typeof options?.index === 'number' && this.model.isSticky(options.index)),
			sticky: options?.sticky || (typeof options?.index === 'number' && this.model.isSticky(options.index)),
			active: this.count === 0 || !options || !options.inactive,
			supportSideBySide: internalOptions?.supportSideBySide
		};

		if (options?.sticky && typeof options?.index === 'number' && !this.model.isSticky(options.index)) {
			// Special case: we are to open an editor sticky but at an index that is not sticky
			// In that case we prefer to open the editor at the index but not sticky. This enables
			// to drag a sticky editor to an index that is not sticky to unstick it.
			openEditorOptions.sticky = false;
		}

		if (!openEditorOptions.active && !openEditorOptions.pinned && this.model.activeEditor && !this.model.isPinned(this.model.activeEditor)) {
			// Special case: we are to open an editor inactive and not pinned, but the current active
			// editor is also not pinned, which means it will get replaced with this one. As such,
			// the editor can only be active.
			openEditorOptions.active = true;
		}

		let activateGroup = false;
		let restoreGroup = false;

		if (options?.activation === EditorActivation.ACTIVATE) {
			// Respect option to force activate an editor group.
			activateGroup = true;
		} else if (options?.activation === EditorActivation.RESTORE) {
			// Respect option to force restore an editor group.
			restoreGroup = true;
		} else if (options?.activation === EditorActivation.PRESERVE) {
			// Respect option to preserve active editor group.
			activateGroup = false;
			restoreGroup = false;
		} else if (openEditorOptions.active) {
			// Finally, we only activate/restore an editor which is
			// opening as active editor.
			// If preserveFocus is enabled, we only restore but never
			// activate the group.
			activateGroup = !options || !options.preserveFocus;
			restoreGroup = !activateGroup;
		}

		// Actually move the editor if a specific index is provided and we figure
		// out that the editor is already opened at a different index. This
		// ensures the right set of events are fired to the outside.
		if (typeof openEditorOptions.index === 'number') {
			const indexOfEditor = this.model.indexOf(editor);
			if (indexOfEditor !== -1 && indexOfEditor !== openEditorOptions.index) {
				this.doMoveEditorInsideGroup(editor, openEditorOptions);
			}
		}

		// Update model and make sure to continue to use the editor we get from
		// the model. It is possible that the editor was already opened and we
		// want to ensure that we use the existing instance in that case.
		const { editor: openedEditor, isNew } = this.model.openEditor(editor, openEditorOptions);

		// Conditionally lock the group
		if (
			isNew &&						// only if this editor was new for the group
			this.count === 1 &&				// only when this editor was the first editor in the group
			this.accessor.groups.length > 1	// only when there are more than one groups open
		) {
			// only when the editor identifier is configured as such
			if (openedEditor.editorId && this.accessor.partOptions.autoLockGroups?.has(openedEditor.editorId)) {
				this.lock(true);
			}
		}

		// Show editor
		const showEditorResult = this.doShowEditor(openedEditor, { active: !!openEditorOptions.active, isNew }, options, internalOptions);

		// Finally make sure the group is active or restored as instructed
		if (activateGroup) {
			this.accessor.activateGroup(this);
		} else if (restoreGroup) {
			this.accessor.restoreGroup(this);
		}

		return showEditorResult;
	}

	private doShowEditor(editor: EditorInput, context: { active: boolean, isNew: boolean }, options?: IEditorOptions, internalOptions?: IInternalEditorOpenOptions): Promise<IEditorPane | undefined> {

		// Show in editor control if the active editor changed
		let openEditorPromise: Promise<IEditorPane | undefined>;
		if (context.active) {
			openEditorPromise = (async () => {
				const result = await this.editorPane.openEditor(editor, options, { newInGroup: context.isNew });

				// Editor change event
				if (result.editorChanged) {
					this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_ACTIVE, editor });
				}

				// Handle errors but do not bubble them up
				if (result.error) {
					await this.doHandleOpenEditorError(result.error, editor, options);
				}

				// Without an editor pane, recover by closing the active editor
				// (if the input is still the active one)
				if (!result.editorPane && this.activeEditor === editor) {
					const focusNext = !options || !options.preserveFocus;
					this.doCloseEditor(editor, focusNext, { fromError: true });
				}

				return result.editorPane;
			})();
		} else {
			openEditorPromise = Promise.resolve(undefined); // inactive: return undefined as result to signal this
		}

		// Show in title control after editor control because some actions depend on it
		// but respect the internal options in case title control updates should skip.
		if (!internalOptions?.skipTitleUpdate) {
			this.titleAreaControl.openEditor(editor);
		}

		return openEditorPromise;
	}

	private async doHandleOpenEditorError(error: Error, editor: EditorInput, options?: IEditorOptions): Promise<void> {

		// Report error only if we are not told to ignore errors that occur from opening an editor
		if (!isPromiseCanceledError(error) && (!options || !options.ignoreError)) {

			// Always log the error to figure out what is going on
			this.logService.error(error);

			// Since it is more likely that errors fail to open when restoring them e.g.
			// because files got deleted or moved meanwhile, we do not show any notifications
			// if we are still restoring editors.
			if (this.isRestored) {

				// Extract possible error actions from the error
				let errorActions: readonly IAction[] | undefined = undefined;
				if (isErrorWithActions(error)) {
					errorActions = error.actions;
				}

				// If the context is USER, we try to show a modal dialog instead of a background notification
				if (options?.context === EditorOpenContext.USER) {
					const buttons: string[] = [];
					if (Array.isArray(errorActions) && errorActions.length > 0) {
						for (const errorAction of errorActions) {
							buttons.push(errorAction.label);
						}
					} else {
						buttons.push(localize('ok', 'OK'));
					}

					let cancelId: number | undefined = undefined;
					if (buttons.length === 1) {
						buttons.push(localize('cancel', "Cancel"));
						cancelId = 1;
					}

					const result = await this.dialogService.show(
						Severity.Error,
						localize('editorOpenErrorDialog', "Unable to open '{0}'", editor.getName()),
						buttons,
						{
							detail: toErrorMessage(error),
							cancelId
						}
					);

					// Make sure to run any error action if present
					if (result.choice !== cancelId && Array.isArray(errorActions)) {
						const errorAction = errorActions[result.choice];
						if (errorAction) {
							errorAction.run();
						}
					}
				}

				// Otherwise, show a background notification.
				else {
					const actions = { primary: [] as readonly IAction[] };
					if (Array.isArray(errorActions)) {
						actions.primary = errorActions;
					}

					const handle = this.notificationService.notify({
						id: `${hash(editor.resource?.toString())}`, // unique per editor
						severity: Severity.Error,
						message: localize('editorOpenError', "Unable to open '{0}': {1}.", editor.getName(), toErrorMessage(error)),
						actions
					});

					Event.once(handle.onDidClose)(() => actions.primary && dispose(actions.primary));
				}
			}
		}

		// Event
		this._onDidOpenEditorFail.fire(editor);
	}

	//#endregion

	//#region openEditors()

	async openEditors(editors: { editor: EditorInput, options?: IEditorOptions }[]): Promise<IEditorPane | null> {

		// Guard against invalid editors. Disposed editors
		// should never open because they emit no events
		// e.g. to indicate dirty changes.
		const editorsToOpen = coalesce(editors).filter(({ editor }) => !editor.isDisposed());

		// Use the first editor as active editor
		const firstEditor = firstOrDefault(editorsToOpen);
		if (!firstEditor) {
			return null;
		}

		const openEditorsOptions: IInternalEditorOpenOptions = {
			// Allow to match on a side-by-side editor when same
			// editor is opened on both sides. In that case we
			// do not want to open a new editor but reuse that one.
			supportSideBySide: SideBySideEditor.BOTH
		};

		await this.doOpenEditor(firstEditor.editor, firstEditor.options, openEditorsOptions);

		// Open the other ones inactive
		const inactiveEditors = editorsToOpen.slice(1);
		const startingIndex = this.getIndexOfEditor(firstEditor.editor) + 1;
		await Promises.settled(inactiveEditors.map(({ editor, options }, index) => {
			return this.doOpenEditor(editor, {
				...options,
				inactive: true,
				pinned: true,
				index: startingIndex + index
			}, {
				...openEditorsOptions,
				// optimization: update the title control later
				// https://github.com/microsoft/vscode/issues/130634
				skipTitleUpdate: true
			});
		}));

		// Update the title control all at once with all editors
		this.titleAreaControl.openEditors(inactiveEditors.map(({ editor }) => editor));

		// Opening many editors at once can put any editor to be
		// the active one depending on options. As such, we simply
		// return the active editor pane after this operation.
		return this.editorPane.activeEditorPane;
	}

	//#endregion

	//#region moveEditor()

	moveEditors(editors: { editor: EditorInput, options?: IEditorOptions }[], target: EditorGroupView): void {

		// Optimization: knowing that we move many editors, we
		// delay the title update to a later point for this group
		// through a method that allows for bulk updates but only
		// when moving to a different group where many editors
		// are more likely to occur.
		const internalOptions: IInternalMoveCopyOptions = {
			skipTitleUpdate: this !== target
		};

		for (const { editor, options } of editors) {
			this.moveEditor(editor, target, options, internalOptions);
		}

		// Update the title control all at once with all editors
		// in source and target if the title update was skipped
		if (internalOptions.skipTitleUpdate) {
			const movedEditors = editors.map(({ editor }) => editor);
			target.titleAreaControl.openEditors(movedEditors);
			this.titleAreaControl.closeEditors(movedEditors);
		}
	}

	moveEditor(editor: EditorInput, target: EditorGroupView, options?: IEditorOptions, internalOptions?: IInternalEditorTitleControlOptions): void {

		// Move within same group
		if (this === target) {
			this.doMoveEditorInsideGroup(editor, options);
		}

		// Move across groups
		else {
			this.doMoveOrCopyEditorAcrossGroups(editor, target, options, { ...internalOptions, keepCopy: false });
		}
	}

	private doMoveEditorInsideGroup(candidate: EditorInput, options?: IEditorOpenOptions): void {
		const moveToIndex = options ? options.index : undefined;
		if (typeof moveToIndex !== 'number') {
			return; // do nothing if we move into same group without index
		}

		const currentIndex = this.model.indexOf(candidate);
		if (currentIndex === -1 || currentIndex === moveToIndex) {
			return; // do nothing if editor unknown in model or is already at the given index
		}

		// Update model and make sure to continue to use the editor we get from
		// the model. It is possible that the editor was already opened and we
		// want to ensure that we use the existing instance in that case.
		const editor = this.model.getEditorByIndex(currentIndex);
		if (!editor) {
			return;
		}

		// Update model
		this.model.moveEditor(editor, moveToIndex);
		this.model.pin(editor);

		// Forward to title area
		this.titleAreaControl.moveEditor(editor, currentIndex, moveToIndex);
		this.titleAreaControl.pinEditor(editor);
	}

	private doMoveOrCopyEditorAcrossGroups(editor: EditorInput, target: EditorGroupView, openOptions?: IEditorOpenOptions, internalOptions?: IInternalMoveCopyOptions): void {
		const keepCopy = internalOptions?.keepCopy;

		// When moving/copying an editor, try to preserve as much view state as possible
		// by checking for the editor to be a text editor and creating the options accordingly
		// if so
		const options = fillActiveEditorViewState(this, editor, {
			...openOptions,
			pinned: true, 										// always pin moved editor
			sticky: !keepCopy && this.model.isSticky(editor)	// preserve sticky state only if editor is moved (https://github.com/microsoft/vscode/issues/99035)
		});

		// Indicate will move event
		if (!keepCopy) {
			this._onWillMoveEditor.fire({
				groupId: this.id,
				editor,
				target: target.id
			});
		}

		// A move to another group is an open first...
		target.doOpenEditor(keepCopy ? editor.copy() : editor, options, internalOptions);

		// ...and a close afterwards (unless we copy)
		if (!keepCopy) {
			this.doCloseEditor(editor, false /* do not focus next one behind if any */, { ...internalOptions, fromMove: true });
		}
	}

	//#endregion

	//#region copyEditor()

	copyEditors(editors: { editor: EditorInput, options?: IEditorOptions }[], target: EditorGroupView): void {

		// Optimization: knowing that we move many editors, we
		// delay the title update to a later point for this group
		// through a method that allows for bulk updates but only
		// when moving to a different group where many editors
		// are more likely to occur.
		const internalOptions: IInternalMoveCopyOptions = {
			skipTitleUpdate: this !== target
		};

		for (const { editor, options } of editors) {
			this.copyEditor(editor, target, options, internalOptions);
		}

		// Update the title control all at once with all editors
		// in target if the title update was skipped
		if (internalOptions.skipTitleUpdate) {
			const copiedEditors = editors.map(({ editor }) => editor);
			target.titleAreaControl.openEditors(copiedEditors);
		}
	}

	copyEditor(editor: EditorInput, target: EditorGroupView, options?: IEditorOptions, internalOptions?: IInternalEditorTitleControlOptions): void {

		// Move within same group because we do not support to show the same editor
		// multiple times in the same group
		if (this === target) {
			this.doMoveEditorInsideGroup(editor, options);
		}

		// Copy across groups
		else {
			this.doMoveOrCopyEditorAcrossGroups(editor, target, options, { ...internalOptions, keepCopy: true });
		}
	}

	//#endregion

	//#region closeEditor()

	async closeEditor(editor: EditorInput | undefined = this.activeEditor || undefined, options?: ICloseEditorOptions): Promise<void> {
		await this.doCloseEditorWithDirtyHandling(editor, options);
	}

	private async doCloseEditorWithDirtyHandling(editor: EditorInput | undefined = this.activeEditor || undefined, options?: ICloseEditorOptions): Promise<boolean> {
		if (!editor) {
			return false;
		}

		// Check for dirty and veto
		const veto = await this.handleDirtyClosing([editor]);
		if (veto) {
			return false;
		}

		// Do close
		this.doCloseEditor(editor, options?.preserveFocus ? false : undefined);

		return true;
	}

	private doCloseEditor(editor: EditorInput, focusNext = (this.accessor.activeGroup === this), internalOptions?: IInternalEditorCloseOptions): void {
		let index: number | undefined;

		// Closing the active editor of the group is a bit more work
		if (this.model.isActive(editor)) {
			index = this.doCloseActiveEditor(focusNext, internalOptions);
		}

		// Closing inactive editor is just a model update
		else {
			index = this.doCloseInactiveEditor(editor, internalOptions);
		}

		// Forward to title control unless skipped via internal options
		if (!internalOptions?.skipTitleUpdate) {
			this.titleAreaControl.closeEditor(editor, index);
		}
	}

	private doCloseActiveEditor(focusNext = (this.accessor.activeGroup === this), internalOptions?: IInternalEditorCloseOptions): number | undefined {
		const editorToClose = this.activeEditor;
		const restoreFocus = this.shouldRestoreFocus(this.element);

		// Optimization: if we are about to close the last editor in this group and settings
		// are configured to close the group since it will be empty, we first set the last
		// active group as empty before closing the editor. This reduces the amount of editor
		// change events that this operation emits and will reduce flicker. Without this
		// optimization, this group (if active) would first trigger a active editor change
		// event because it became empty, only to then trigger another one when the next
		// group gets active.
		const closeEmptyGroup = this.accessor.partOptions.closeEmptyGroups;
		if (closeEmptyGroup && this.active && this.count === 1) {
			const mostRecentlyActiveGroups = this.accessor.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
			const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current one, so take [1]
			if (nextActiveGroup) {
				if (restoreFocus) {
					nextActiveGroup.focus();
				} else {
					this.accessor.activateGroup(nextActiveGroup);
				}
			}
		}

		// Update model
		let index: number | undefined = undefined;
		if (editorToClose) {
			index = this.model.closeEditor(editorToClose, internalOptions?.fromMove ? EditorCloseContext.MOVE : undefined)?.index;
		}

		// Open next active if there are more to show
		const nextActiveEditor = this.model.activeEditor;
		if (nextActiveEditor) {
			const preserveFocus = !focusNext;

			let activation: EditorActivation | undefined = undefined;
			if (preserveFocus && this.accessor.activeGroup !== this) {
				// If we are opening the next editor in an inactive group
				// without focussing it, ensure we preserve the editor
				// group sizes in case that group is minimized.
				// https://github.com/microsoft/vscode/issues/117686
				activation = EditorActivation.PRESERVE;
			}

			const options: IEditorOptions = {
				preserveFocus,
				activation,
				// When closing an editor due to an error we can end up in a loop where we continue closing
				// editors that fail to open (e.g. when the file no longer exists). We do not want to show
				// repeated errors in this case to the user. As such, if we open the next editor and we are
				// in a scope of a previous editor failing, we silence the input errors until the editor is
				// opened by setting ignoreError: true.
				ignoreError: internalOptions?.fromError
			};

			this.doOpenEditor(nextActiveEditor, options);
		}

		// Otherwise we are empty, so clear from editor control and send event
		else {

			// Forward to editor pane
			if (editorToClose) {
				this.editorPane.closeEditor(editorToClose);
			}

			// Restore focus to group container as needed unless group gets closed
			if (restoreFocus && !closeEmptyGroup) {
				this.focus();
			}

			// Events
			this._onDidGroupChange.fire({ kind: GroupChangeKind.EDITOR_ACTIVE });

			// Remove empty group if we should
			if (closeEmptyGroup) {
				this.accessor.removeGroup(this);
			}
		}

		return index;
	}

	private shouldRestoreFocus(target: Element): boolean {
		const activeElement = document.activeElement;

		if (activeElement === document.body) {
			return true; // always restore focus if nothing is focused currently
		}

		// otherwise check for the active element being an ancestor of the target
		return isAncestor(activeElement, target);
	}

	private doCloseInactiveEditor(editor: EditorInput, internalOptions?: IInternalEditorCloseOptions): number | undefined {

		// Update model
		return this.model.closeEditor(editor, internalOptions?.fromMove ? EditorCloseContext.MOVE : undefined)?.index;
	}

	private async handleDirtyClosing(editors: EditorInput[]): Promise<boolean /* veto */> {
		if (!editors.length) {
			return false; // no veto
		}

		const editor = editors.shift()!;

		// To prevent multiple confirmation dialogs from showing up one after the other
		// we check if a pending confirmation is currently showing and if so, join that
		let handleDirtyClosingPromise = this.mapEditorToPendingConfirmation.get(editor);
		if (!handleDirtyClosingPromise) {
			handleDirtyClosingPromise = this.doHandleDirtyClosing(editor);
			this.mapEditorToPendingConfirmation.set(editor, handleDirtyClosingPromise);
		}

		let veto: boolean;
		try {
			veto = await handleDirtyClosingPromise;
		} finally {
			this.mapEditorToPendingConfirmation.delete(editor);
		}

		// Return for the first veto we got
		if (veto) {
			return veto;
		}

		// Otherwise continue with the remainders
		return this.handleDirtyClosing(editors);
	}

	private async doHandleDirtyClosing(editor: EditorInput, options?: { skipAutoSave: boolean }): Promise<boolean /* veto */> {
		if (!editor.isDirty() || editor.isSaving()) {
			return false; // editor must be dirty and not saving
		}

		if (editor instanceof SideBySideEditorInput && this.model.contains(editor.primary)) {
			return false; // primary-side of editor is still opened somewhere else
		}

		// Note: we explicitly decide to ask for confirm if closing a normal editor even
		// if it is opened in a side-by-side editor in the group. This decision is made
		// because it may be less obvious that one side of a side by side editor is dirty
		// and can still be changed.

		if (this.accessor.groups.some(groupView => {
			if (groupView === this) {
				return false; // skip this group to avoid false assumptions about the editor being opened still
			}

			const otherGroup = groupView;
			if (otherGroup.contains(editor)) {
				return true; // exact editor still opened
			}

			if (editor instanceof SideBySideEditorInput && otherGroup.contains(editor.primary)) {
				return true; // primary side of side by side editor still opened
			}

			return false;
		})) {
			return false; // editor is still editable somewhere else
		}

		// In some cases trigger save before opening the dialog depending
		// on auto-save configuration.
		// However, make sure to respect `skipAutoSave` option in case the automated
		// save fails which would result in the editor never closing.
		let confirmation = ConfirmResult.CANCEL;
		let saveReason = SaveReason.EXPLICIT;
		let autoSave = false;
		if (!editor.hasCapability(EditorInputCapabilities.Untitled) && !options?.skipAutoSave) {

			// Auto-save on focus change: save, because a dialog would steal focus
			// (see https://github.com/microsoft/vscode/issues/108752)
			if (this.filesConfigurationService.getAutoSaveMode() === AutoSaveMode.ON_FOCUS_CHANGE) {
				autoSave = true;
				confirmation = ConfirmResult.SAVE;
				saveReason = SaveReason.FOCUS_CHANGE;
			}

			// Auto-save on window change: save, because on Windows and Linux, a
			// native dialog triggers the window focus change
			// (see https://github.com/microsoft/vscode/issues/134250)
			else if ((isNative && (isWindows || isLinux)) && this.filesConfigurationService.getAutoSaveMode() === AutoSaveMode.ON_WINDOW_CHANGE) {
				autoSave = true;
				confirmation = ConfirmResult.SAVE;
				saveReason = SaveReason.WINDOW_CHANGE;
			}
		}

		// No auto-save on focus change: ask user
		if (!autoSave) {

			// Switch to editor that we want to handle and confirm to save/revert
			await this.doOpenEditor(editor);

			// Let editor handle confirmation if implemented
			if (typeof editor.confirm === 'function') {
				confirmation = await editor.confirm();
			}

			// Show a file specific confirmation
			else {
				let name: string;
				if (editor instanceof SideBySideEditorInput) {
					name = editor.primary.getName(); // prefer shorter names by using primary's name in this case
				} else {
					name = editor.getName();
				}

				confirmation = await this.fileDialogService.showSaveConfirm([name]);
			}
		}

		// It could be that the editor saved meanwhile or is saving, so we check
		// again to see if anything needs to happen before closing for good.
		// This can happen for example if autoSave: onFocusChange is configured
		// so that the save happens when the dialog opens.
		if (!editor.isDirty() || editor.isSaving()) {
			return confirmation === ConfirmResult.CANCEL ? true : false;
		}

		// Otherwise, handle accordingly
		switch (confirmation) {
			case ConfirmResult.SAVE:
				const result = await editor.save(this.id, { reason: saveReason });
				if (!result && autoSave) {
					// Save failed and we need to signal this back to the user, so
					// we handle the dirty editor again but this time ensuring to
					// show the confirm dialog
					// (see https://github.com/microsoft/vscode/issues/108752)
					return this.doHandleDirtyClosing(editor, { skipAutoSave: true });
				}

				return editor.isDirty(); // veto if still dirty
			case ConfirmResult.DONT_SAVE:
				try {

					// first try a normal revert where the contents of the editor are restored
					await editor.revert(this.id);

					return editor.isDirty(); // veto if still dirty
				} catch (error) {
					// if that fails, since we are about to close the editor, we accept that
					// the editor cannot be reverted and instead do a soft revert that just
					// enables us to close the editor. With this, a user can always close a
					// dirty editor even when reverting fails.
					await editor.revert(this.id, { soft: true });

					return editor.isDirty(); // veto if still dirty
				}
			case ConfirmResult.CANCEL:
				return true; // veto
		}
	}

	//#endregion

	//#region closeEditors()

	async closeEditors(args: EditorInput[] | ICloseEditorsFilter, options?: ICloseEditorOptions): Promise<void> {
		if (this.isEmpty) {
			return;
		}

		const editors = this.doGetEditorsToClose(args);

		// Check for dirty and veto
		const veto = await this.handleDirtyClosing(editors.slice(0));
		if (veto) {
			return;
		}

		// Do close
		this.doCloseEditors(editors, options);
	}

	private doGetEditorsToClose(args: EditorInput[] | ICloseEditorsFilter): EditorInput[] {
		if (Array.isArray(args)) {
			return args;
		}

		const filter = args;
		const hasDirection = typeof filter.direction === 'number';

		let editorsToClose = this.model.getEditors(hasDirection ? EditorsOrder.SEQUENTIAL : EditorsOrder.MOST_RECENTLY_ACTIVE, filter); // in MRU order only if direction is not specified

		// Filter: saved or saving only
		if (filter.savedOnly) {
			editorsToClose = editorsToClose.filter(editor => !editor.isDirty() || editor.isSaving());
		}

		// Filter: direction (left / right)
		else if (hasDirection && filter.except) {
			editorsToClose = (filter.direction === CloseDirection.LEFT) ?
				editorsToClose.slice(0, this.model.indexOf(filter.except, editorsToClose)) :
				editorsToClose.slice(this.model.indexOf(filter.except, editorsToClose) + 1);
		}

		// Filter: except
		else if (filter.except) {
			editorsToClose = editorsToClose.filter(editor => filter.except && !editor.matches(filter.except));
		}

		return editorsToClose;
	}

	private doCloseEditors(editors: EditorInput[], options?: ICloseEditorOptions): void {

		// Close all inactive editors first
		let closeActiveEditor = false;
		for (const editor of editors) {
			if (!this.isActive(editor)) {
				this.doCloseInactiveEditor(editor);
			} else {
				closeActiveEditor = true;
			}
		}

		// Close active editor last if contained in editors list to close
		if (closeActiveEditor) {
			this.doCloseActiveEditor(options?.preserveFocus ? false : undefined);
		}

		// Forward to title control
		if (editors.length) {
			this.titleAreaControl.closeEditors(editors);
		}
	}

	//#endregion

	//#region closeAllEditors()

	async closeAllEditors(options?: ICloseAllEditorsOptions): Promise<void> {
		if (this.isEmpty) {

			// If the group is empty and the request is to close all editors, we still close
			// the editor group is the related setting to close empty groups is enabled for
			// a convenient way of removing empty editor groups for the user.
			if (this.accessor.partOptions.closeEmptyGroups) {
				this.accessor.removeGroup(this);
			}

			return;
		}

		// Check for dirty and veto
		const veto = await this.handleDirtyClosing(this.model.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, options));
		if (veto) {
			return;
		}

		// Do close
		this.doCloseAllEditors(options);
	}

	private doCloseAllEditors(options?: ICloseAllEditorsOptions): void {

		// Close all inactive editors first
		const editorsToClose: EditorInput[] = [];
		for (const editor of this.model.getEditors(EditorsOrder.SEQUENTIAL, options)) {
			if (!this.isActive(editor)) {
				this.doCloseInactiveEditor(editor);
			}

			editorsToClose.push(editor);
		}

		// Close active editor last (unless we skip it, e.g. because it is sticky)
		if (this.activeEditor && editorsToClose.includes(this.activeEditor)) {
			this.doCloseActiveEditor();
		}

		// Forward to title control
		if (editorsToClose.length) {
			this.titleAreaControl.closeEditors(editorsToClose);
		}
	}

	//#endregion

	//#region replaceEditors()

	async replaceEditors(editors: EditorReplacement[]): Promise<void> {

		// Extract active vs. inactive replacements
		let activeReplacement: EditorReplacement | undefined;
		const inactiveReplacements: EditorReplacement[] = [];
		for (let { editor, replacement, forceReplaceDirty, options } of editors) {
			const index = this.getIndexOfEditor(editor);
			if (index >= 0) {
				const isActiveEditor = this.isActive(editor);

				// make sure we respect the index of the editor to replace
				if (options) {
					options.index = index;
				} else {
					options = { index };
				}

				options.inactive = !isActiveEditor;
				options.pinned = options.pinned ?? true; // unless specified, prefer to pin upon replace

				const editorToReplace = { editor, replacement, forceReplaceDirty, options };
				if (isActiveEditor) {
					activeReplacement = editorToReplace;
				} else {
					inactiveReplacements.push(editorToReplace);
				}
			}
		}

		// Handle inactive first
		for (const { editor, replacement, forceReplaceDirty, options } of inactiveReplacements) {

			// Open inactive editor
			await this.doOpenEditor(replacement, options);

			// Close replaced inactive editor unless they match
			if (!editor.matches(replacement)) {
				let closed = false;
				if (forceReplaceDirty) {
					this.doCloseEditor(editor, false);
					closed = true;
				} else {
					closed = await this.doCloseEditorWithDirtyHandling(editor, { preserveFocus: true });
				}
				if (!closed) {
					return; // canceled
				}
			}
		}

		// Handle active last
		if (activeReplacement) {

			// Open replacement as active editor
			const openEditorResult = this.doOpenEditor(activeReplacement.replacement, activeReplacement.options);

			// Close replaced active editor unless they match
			if (!activeReplacement.editor.matches(activeReplacement.replacement)) {
				if (activeReplacement.forceReplaceDirty) {
					this.doCloseEditor(activeReplacement.editor, false);
				} else {
					await this.doCloseEditorWithDirtyHandling(activeReplacement.editor, { preserveFocus: true });
				}
			}

			await openEditorResult;
		}
	}

	//#endregion

	//#region Locking

	get isLocked(): boolean {
		if (this.accessor.groups.length === 1) {
			// Special case: if only 1 group is opened, never report it as locked
			// to ensure editors can always open in the "default" editor group
			return false;
		}

		return this.model.isLocked;
	}

	lock(locked: boolean): void {
		if (this.accessor.groups.length === 1) {
			// Special case: if only 1 group is opened, never allow to lock
			// to ensure editors can always open in the "default" editor group
			locked = false;
		}

		this.model.lock(locked);
	}

	//#endregion

	//#region Themable

	protected override updateStyles(): void {
		const isEmpty = this.isEmpty;

		// Container
		if (isEmpty) {
			this.element.style.backgroundColor = this.getColor(EDITOR_GROUP_EMPTY_BACKGROUND) || '';
		} else {
			this.element.style.backgroundColor = '';
		}

		// Title control
		const borderColor = this.getColor(EDITOR_GROUP_HEADER_BORDER) || this.getColor(contrastBorder);
		if (!isEmpty && borderColor) {
			this.titleContainer.classList.add('title-border-bottom');
			this.titleContainer.style.setProperty('--title-border-bottom-color', borderColor.toString());
		} else {
			this.titleContainer.classList.remove('title-border-bottom');
			this.titleContainer.style.removeProperty('--title-border-bottom-color');
		}

		const { showTabs } = this.accessor.partOptions;
		this.titleContainer.style.backgroundColor = this.getColor(showTabs ? EDITOR_GROUP_HEADER_TABS_BACKGROUND : EDITOR_GROUP_HEADER_NO_TABS_BACKGROUND) || '';

		// Editor container
		this.editorContainer.style.backgroundColor = this.getColor(editorBackground) || '';
	}

	//#endregion

	//#region ISerializableView

	readonly element: HTMLElement = document.createElement('div');

	get minimumWidth(): number { return this.editorPane.minimumWidth; }
	get minimumHeight(): number { return this.editorPane.minimumHeight; }
	get maximumWidth(): number { return this.editorPane.maximumWidth; }
	get maximumHeight(): number { return this.editorPane.maximumHeight; }

	private _onDidChange = this._register(new Relay<{ width: number; height: number; } | undefined>());
	readonly onDidChange = this._onDidChange.event;

	layout(width: number, height: number): void {
		this.dimension = new Dimension(width, height);

		// Layout the title area first to receive the size it occupies
		const titleAreaSize = this.titleAreaControl.layout({
			container: this.dimension,
			available: new Dimension(width, height - this.editorPane.minimumHeight)
		});

		// Pass the container width and remaining height to the editor layout
		const editorHeight = Math.max(0, height - titleAreaSize.height);
		this.editorContainer.style.height = `${editorHeight}px`;
		this.editorPane.layout(new Dimension(width, editorHeight));
	}

	relayout(): void {
		if (this.dimension) {
			const { width, height } = this.dimension;
			this.layout(width, height);
		}
	}

	toJSON(): ISerializedEditorGroupModel {
		return this.model.serialize();
	}

	//#endregion

	override dispose(): void {
		this._disposed = true;

		this._onWillDispose.fire();

		this.titleAreaControl.dispose();

		super.dispose();
	}
}

export interface EditorReplacement extends IEditorReplacement {
	readonly editor: EditorInput;
	readonly replacement: EditorInput;
	readonly options?: IEditorOptions;
}

registerThemingParticipant((theme, collector) => {

	// Letterpress
	const letterpress = `./media/letterpress${theme.type === 'dark' ? '-dark' : theme.type === 'hc' ? '-hc' : ''}.svg`;
	collector.addRule(`
		.monaco-workbench .part.editor > .content .editor-group-container.empty .editor-group-letterpress {
			background-image: ${asCSSUrl(FileAccess.asBrowserUri(letterpress, require))}
		}
	`);

	// Focused Empty Group Border
	const focusedEmptyGroupBorder = theme.getColor(EDITOR_GROUP_FOCUSED_EMPTY_BORDER);
	if (focusedEmptyGroupBorder) {
		collector.addRule(`
			.monaco-workbench .part.editor > .content:not(.empty) .editor-group-container.empty.active:focus {
				outline-width: 1px;
				outline-color: ${focusedEmptyGroupBorder};
				outline-offset: -2px;
				outline-style: solid;
			}

			.monaco-workbench .part.editor > .content.empty .editor-group-container.empty.active:focus {
				outline: none; /* never show outline for empty group if it is the last */
			}
		`);
	} else {
		collector.addRule(`
			.monaco-workbench .part.editor > .content .editor-group-container.empty.active:focus {
				outline: none; /* disable focus outline unless active empty group border is defined */
			}
		`);
	}
});
