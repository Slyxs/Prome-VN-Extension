import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../constants.js";
import { uploadTextboxImage } from "../utils.js";

/*
 * Custom Textboxes
 * -----------------
 * Renders a Ren'Py-style textbox that plays back a classified message one segment at a
 * time. Textboxes are fully configured in-app: the user uploads a frame image, then
 * clicks "Edit Layout" to drag/resize the name and dialogue areas directly on the real,
 * on-screen textbox (no separate popup/preview - what you see is exactly what plays
 * back). Font family/size/color/bold/italic/shadow/outline are all editable live from
 * the settings panel while editing. Everything is stored as a "profile" in the
 * extension's own settings (`textboxProfiles`) - no manual file/JSON placement required.
 *
 * Profile shape:
 * {
 *   id: string,
 *   name: string,
 *   imageUrl: string,
 *   nameArea: { enabled, top, left, width, height, fontFamily, fontSize, fontColor, bold, italic, shadow, outlineColor, outlineWidth },
 *   dialogueArea: { top, left, width, height, fontFamily, fontSize, fontColor, bold, italic, shadow, outlineColor, outlineWidth },
 * }
 * (top/left/width/height are percentages of the textbox's own size, fontSize/outlineWidth are in px.)
 */

const AREA_STYLE_DEFAULTS = {
	fontFamily: "'Segoe UI', sans-serif",
	fontSize: 18,
	fontColor: "#ffffff",
	bold: false,
	italic: false,
	shadow: false,
	outlineColor: "#000000",
	outlineWidth: 0,
};

/** Whether the live, on-screen layout editor is currently active. */
let editModeActive = false;

function settings() {
	return extension_settings[extensionName];
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function getPoint(event) {
	return event.touches?.[0] ?? event;
}

/* ---------------------------------------------------------------------- */
/* Profile helpers                                                        */
/* ---------------------------------------------------------------------- */

function createDefaultProfile(name, imageUrl) {
	return {
		id: `textbox_${Date.now()}`,
		name,
		imageUrl,
		nameArea: {
			enabled: true,
			top: 4,
			left: 6,
			width: 30,
			height: 14,
			...AREA_STYLE_DEFAULTS,
			fontSize: 22,
			fontColor: "#ffcc00",
			bold: true,
			shadow: true,
		},
		dialogueArea: {
			top: 22,
			left: 6,
			width: 88,
			height: 66,
			...AREA_STYLE_DEFAULTS,
		},
	};
}

/**
 * Backfills any missing style fields on a profile's areas with defaults, so profiles
 * saved before new style options were added keep working without manual migration.
 */
function normalizeProfile(profile) {
	profile.nameArea = Object.assign({ enabled: true }, AREA_STYLE_DEFAULTS, profile.nameArea);
	profile.dialogueArea = Object.assign({}, AREA_STYLE_DEFAULTS, profile.dialogueArea);
	return profile;
}

function getProfiles() {
	if (!Array.isArray(settings().textboxProfiles)) {
		settings().textboxProfiles = [];
	}
	settings().textboxProfiles.forEach(normalizeProfile);
	return settings().textboxProfiles;
}

function getActiveProfile() {
	return getProfiles().find((profile) => profile.id === settings().activeTextboxId) ?? null;
}

/* ---------------------------------------------------------------------- */
/* On-screen textbox DOM / Styling                                        */
/* ---------------------------------------------------------------------- */

function injectCustomTextboxElement() {
	if ($("#prome-custom-textbox").length) return;

	const html = `
		<div id="prome-custom-textbox" class="prome-custom-textbox displayNone">
			<div id="prome-textbox-drag-handle" class="prome-textbox-drag-handle fa-solid fa-grip" title="Drag to move"></div>
			<img id="prome-textbox-bg" class="prome-textbox-bg" alt="" />
			<div id="prome-textbox-editor-grid" class="prome-textbox-editor-grid">
				<div class="prome-editor-grid-line prome-editor-grid-line-v" style="left:25%"></div>
				<div class="prome-editor-grid-line prome-editor-grid-line-v prome-editor-grid-line-center" style="left:50%"></div>
				<div class="prome-editor-grid-line prome-editor-grid-line-v" style="left:75%"></div>
				<div class="prome-editor-grid-line prome-editor-grid-line-h" style="top:25%"></div>
				<div class="prome-editor-grid-line prome-editor-grid-line-h prome-editor-grid-line-center" style="top:50%"></div>
				<div class="prome-editor-grid-line prome-editor-grid-line-h" style="top:75%"></div>
				<div id="prome-textbox-guide-v" class="prome-editor-snap-guide prome-editor-snap-guide-v"></div>
				<div id="prome-textbox-guide-h" class="prome-editor-snap-guide prome-editor-snap-guide-h"></div>
			</div>
			<div id="prome-textbox-name-area" class="prome-textbox-name-area">
				<div class="prome-editor-area-label" data-i18n="Name">Name</div>
				<span id="prome-textbox-name-text" class="prome-textbox-name-text"></span>
				<div class="prome-editor-resize-handle"></div>
			</div>
			<div id="prome-textbox-dialogue-area" class="prome-textbox-dialogue-area">
				<div class="prome-editor-area-label" data-i18n="Dialogue">Dialogue</div>
				<span id="prome-textbox-dialogue-text" class="prome-textbox-dialogue-text"></span>
				<div class="prome-editor-resize-handle"></div>
			</div>
		</div>
	`;

	$("body").append(html);
}

/**
 * Applies a single area's position/size/font styling to a pair of (box, text) elements.
 * @param {JQuery} $area - The positioned box element
 * @param {JQuery} $text - The text element inside the box
 * @param {object} area - The area config (top/left/width/height/fontSize/fontColor/shadow)
 */
function styleAreaBox($area, $text, area) {
	if (!area) return;

	$area.css({
		top: `${area.top}%`,
		left: `${area.left}%`,
		width: `${area.width}%`,
		height: `${area.height}%`,
	});

	const textEl = $text[0];
	if (!textEl) return;

	const outlineWidth = Number(area.outlineWidth) || 0;
	textEl.style.fontFamily = area.fontFamily || AREA_STYLE_DEFAULTS.fontFamily;
	textEl.style.fontSize = `${area.fontSize}px`;
	textEl.style.fontWeight = area.bold ? "bold" : "normal";
	textEl.style.fontStyle = area.italic ? "italic" : "normal";
	textEl.style.color = area.fontColor;
	textEl.style.textShadow = area.shadow ? "2px 2px 4px rgba(0, 0, 0, 0.8)" : "none";
	textEl.style.webkitTextStroke = outlineWidth > 0 ? `${outlineWidth}px ${area.outlineColor || "#000000"}` : "0px transparent";
}

function applyScale() {
	const pct = clamp(Number(settings().textboxScale) || 100, 50, 200);
	$("#prome-custom-textbox").css("transform", `scale(${pct / 100})`);
}

function restorePosition() {
	const position = settings().textboxPosition;
	const $textbox = $("#prome-custom-textbox");

	if (position && typeof position.top === "number" && typeof position.left === "number") {
		$textbox.css({ top: `${position.top}px`, left: `${position.left}px`, bottom: "auto", right: "auto" });
	} else {
		$textbox.css({ top: "", left: "", bottom: "", right: "" });
	}
}

function makeDraggable($textbox, $handle) {
	let dragging = false;
	let startX = 0;
	let startY = 0;
	let startTop = 0;
	let startLeft = 0;

	function getPoint(event) {
		return event.touches?.[0] ?? event;
	}

	function onPointerMove(event) {
		if (!dragging) return;
		const point = getPoint(event);
		const dx = point.clientX - startX;
		const dy = point.clientY - startY;
		const maxTop = window.innerHeight - $textbox.outerHeight();
		const maxLeft = window.innerWidth - $textbox.outerWidth();
		const newTop = Math.min(Math.max(0, startTop + dy), Math.max(0, maxTop));
		const newLeft = Math.min(Math.max(0, startLeft + dx), Math.max(0, maxLeft));

		$textbox.css({ top: `${newTop}px`, left: `${newLeft}px`, bottom: "auto", right: "auto" });
	}

	function onPointerUp() {
		if (!dragging) return;
		dragging = false;
		$(document).off("mousemove.prometextbox touchmove.prometextbox");
		$(document).off("mouseup.prometextbox touchend.prometextbox");

		const rect = $textbox[0].getBoundingClientRect();
		settings().textboxPosition = { top: rect.top, left: rect.left };
		saveSettingsDebounced();
	}

	function onPointerDown(event) {
		dragging = true;
		const point = getPoint(event);
		startX = point.clientX;
		startY = point.clientY;
		const rect = $textbox[0].getBoundingClientRect();
		startTop = rect.top;
		startLeft = rect.left;

		$(document).on("mousemove.prometextbox touchmove.prometextbox", onPointerMove);
		$(document).on("mouseup.prometextbox touchend.prometextbox", onPointerUp);
		event.preventDefault();
	}

	$handle.on("mousedown touchstart", onPointerDown);
}

/**
 * Rebuilds and shows/hides the on-screen custom textbox based on the current settings
 * (enabled state + active profile). Safe to call any time settings change.
 */
export function applyCustomTextboxMode() {
	injectCustomTextboxElement();

	if (!settings().customTextboxEnabled && !editModeActive) {
		clearTimers();
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	const active = getActiveProfile();

	if (!active) {
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	$("#prome-textbox-bg").attr("src", active.imageUrl);
	styleAreaBox($("#prome-textbox-name-area"), $("#prome-textbox-name-text"), active.nameArea);
	styleAreaBox($("#prome-textbox-dialogue-area"), $("#prome-textbox-dialogue-text"), active.dialogueArea);
	$("#prome-textbox-name-area").toggle(Boolean(active.nameArea?.enabled) || editModeActive);

	applyScale();
	restorePosition();
	$("#prome-custom-textbox").removeClass("displayNone");
	$("#prome-custom-textbox").toggleClass("prome-textbox-editing", editModeActive);
}

/* ---------------------------------------------------------------------- */
/* Segment Playback                                                       */
/* ---------------------------------------------------------------------- */

let currentSequence = [];
let currentIndex = -1;
let isTyping = false;
let typewriterTimer = null;
let advanceTimer = null;

function clearTimers() {
	if (typewriterTimer) {
		clearInterval(typewriterTimer);
		typewriterTimer = null;
	}
	if (advanceTimer) {
		clearTimeout(advanceTimer);
		advanceTimer = null;
	}
}

function scheduleAutoAdvance() {
	if (!settings().textboxAutoAdvance) return;
	if (currentIndex >= currentSequence.length - 1) return;

	const delay = Math.max(0, Number(settings().textboxAutoAdvanceDelay) || 0);
	advanceTimer = setTimeout(() => advanceSegment(), delay);
}

function renderSegment(index) {
	clearTimers();
	const segment = currentSequence[index];
	const text = segment?.text_segment ?? "";
	const $text = $("#prome-textbox-dialogue-text");

	if (settings().textboxTextStreaming) {
		isTyping = true;
		let charIndex = 0;
		const speed = Math.max(1, Number(settings().textboxStreamingSpeed) || 35); // characters per second
		const intervalMs = 1000 / speed;

		$text.text("");
		typewriterTimer = setInterval(() => {
			charIndex++;
			$text.text(text.slice(0, charIndex));

			if (charIndex >= text.length) {
				clearInterval(typewriterTimer);
				typewriterTimer = null;
				isTyping = false;
				scheduleAutoAdvance();
			}
		}, intervalMs);
	} else {
		$text.text(text);
		isTyping = false;
		scheduleAutoAdvance();
	}
}

function completeCurrentSegment() {
	clearTimers();
	isTyping = false;
	const segment = currentSequence[currentIndex];
	$("#prome-textbox-dialogue-text").text(segment?.text_segment ?? "");
	scheduleAutoAdvance();
}

function advanceSegment() {
	clearTimers();
	if (currentIndex >= currentSequence.length - 1) return;
	currentIndex++;
	renderSegment(currentIndex);
}

function onTextboxClick() {
	if (!currentSequence.length) return;
	if (isTyping) {
		completeCurrentSegment();
	} else {
		advanceSegment();
	}
}

/**
 * Plays a classified segment sequence in the custom textbox, one segment at a time.
 * Does nothing if the custom textbox isn't enabled/configured.
 * @param {{text_segment: string, expression: string|null, background: string|null, cg: string|null}[]} sequence
 * @param {string} characterName - The name to show in the name area
 */
export function playSequenceInTextbox(sequence, characterName) {
	if (!settings().customTextboxEnabled) return;
	if (!Array.isArray(sequence) || sequence.length === 0) return;
	if (!$("#prome-custom-textbox").length || $("#prome-custom-textbox").hasClass("displayNone")) return;

	currentSequence = sequence;
	currentIndex = 0;

	$("#prome-textbox-name-text").text(characterName ?? "");
	renderSegment(0);
}

/* ---------------------------------------------------------------------- */
/* Live Layout Editor (drag/resize the real, on-screen textbox)          */
/* ---------------------------------------------------------------------- */

function areaSelector(areaKey) {
	return areaKey === "nameArea" ? "#prome-textbox-name-area" : "#prome-textbox-dialogue-area";
}

/* Alignment grid shown while editing - snap fractions (0/25/50/75/100%) of the stage's
 * own width/height, used both for the static visual grid lines and for snapping. */
const SNAP_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
const SNAP_THRESHOLD_PX = 8;

/**
 * Looks for the nearest grid line (0/25/50/75/100% of `axisSize`) to any of the given
 * candidate positions (e.g. an area's left/center/right edge, in px relative to the
 * stage). Returns the best match within `SNAP_THRESHOLD_PX`, or `null` if none is close
 * enough.
 * @param {number[]} candidates - positions (px, relative to the stage) to test
 * @param {number} axisSize - the stage's width or height in px
 * @returns {{offset: number, guidePct: number}|null} `offset` to add to move/resize the
 * candidate onto the grid line; `guidePct` is the line's position for the guide overlay.
 */
function findSnap(candidates, axisSize) {
	let best = null;

	for (const fraction of SNAP_FRACTIONS) {
		const target = axisSize * fraction;
		for (const candidate of candidates) {
			const distance = Math.abs(candidate - target);
			if (distance <= SNAP_THRESHOLD_PX && (!best || distance < best.distance)) {
				best = { distance, offset: target - candidate, guidePct: fraction * 100 };
			}
		}
	}

	return best;
}

/** Shows/hides the vertical/horizontal snap guide lines based on the current snap result. */
function updateSnapGuides(snapX, snapY) {
	$("#prome-textbox-guide-v")
		.toggleClass("active", Boolean(snapX))
		.css("left", snapX ? `${snapX.guidePct}%` : "");
	$("#prome-textbox-guide-h")
		.toggleClass("active", Boolean(snapY))
		.css("top", snapY ? `${snapY.guidePct}%` : "");
}

/**
 * Enables dragging (mousedown on the area) and resizing (mousedown on its corner handle)
 * of a name/dialogue area directly on the real, on-screen textbox. Only takes effect
 * while edit mode is active. Percentages are computed against the textbox's own
 * bounding box, matching the same top/left/width/height % fields used for playback.
 * @param {"nameArea"|"dialogueArea"} areaKey
 */
function setupLiveAreaDragResize(areaKey) {
	const $stage = $("#prome-custom-textbox");
	const $area = $(areaSelector(areaKey));
	let mode = null;
	let startX = 0;
	let startY = 0;
	let startRect = null;

	function stageRect() {
		return $stage[0].getBoundingClientRect();
	}

	function onMove(event) {
		if (!mode) return;
		const rect = stageRect();
		const point = getPoint(event);
		const dx = point.clientX - startX;
		const dy = point.clientY - startY;

		let { top, left, width, height } = startRect;
		let snapX = null;
		let snapY = null;

		if (mode === "move") {
			left = clamp(startRect.left + dx, 0, rect.width - startRect.width);
			top = clamp(startRect.top + dy, 0, rect.height - startRect.height);

			snapX = findSnap([left, left + width / 2, left + width], rect.width);
			if (snapX) left = clamp(left + snapX.offset, 0, rect.width - width);

			snapY = findSnap([top, top + height / 2, top + height], rect.height);
			if (snapY) top = clamp(top + snapY.offset, 0, rect.height - height);
		} else if (mode === "resize") {
			width = clamp(startRect.width + dx, rect.width * 0.05, rect.width - startRect.left);
			height = clamp(startRect.height + dy, rect.height * 0.05, rect.height - startRect.top);

			snapX = findSnap([left + width], rect.width);
			if (snapX) width = clamp(width + snapX.offset, rect.width * 0.05, rect.width - left);

			snapY = findSnap([top + height], rect.height);
			if (snapY) height = clamp(height + snapY.offset, rect.height * 0.05, rect.height - top);
		}

		updateSnapGuides(snapX, snapY);

		$area.css({
			left: `${(left / rect.width) * 100}%`,
			top: `${(top / rect.height) * 100}%`,
			width: `${(width / rect.width) * 100}%`,
			height: `${(height / rect.height) * 100}%`,
		});
	}

	function onUp() {
		if (!mode) return;
		mode = null;
		$(document).off("mousemove.prometbedit touchmove.prometbedit");
		$(document).off("mouseup.prometbedit touchend.prometbedit");
		updateSnapGuides(null, null);

		const active = getActiveProfile();
		if (!active) return;

		const rect = stageRect();
		const areaRect = $area[0].getBoundingClientRect();
		active[areaKey].left = clamp(((areaRect.left - rect.left) / rect.width) * 100, 0, 100);
		active[areaKey].top = clamp(((areaRect.top - rect.top) / rect.height) * 100, 0, 100);
		active[areaKey].width = clamp((areaRect.width / rect.width) * 100, 5, 100);
		active[areaKey].height = clamp((areaRect.height / rect.height) * 100, 5, 100);

		saveSettingsDebounced();
	}

	function startDrag(newMode) {
		return (event) => {
			if (!editModeActive) return;
			mode = newMode;
			const point = getPoint(event);
			startX = point.clientX;
			startY = point.clientY;
			const rect = stageRect();
			const areaRect = $area[0].getBoundingClientRect();
			startRect = {
				left: areaRect.left - rect.left,
				top: areaRect.top - rect.top,
				width: areaRect.width,
				height: areaRect.height,
			};

			$(document).on("mousemove.prometbedit touchmove.prometbedit", onMove);
			$(document).on("mouseup.prometbedit touchend.prometbedit", onUp);
			event.preventDefault();
			event.stopPropagation();
		};
	}

	$area.on("mousedown touchstart", startDrag("move"));
	$area.find(".prome-editor-resize-handle").on("mousedown touchstart", startDrag("resize"));
}

function updateEditButtonLabel() {
	$("#prome-textbox-edit span").text(editModeActive ? "Done Editing" : "Edit Layout");
	$("#prome-textbox-edit i").toggleClass("fa-pen-to-square", !editModeActive).toggleClass("fa-check", editModeActive);
	$("#prome-textbox-edit").toggleClass("prome-textbox-editing-active", editModeActive);
}

/**
 * Turns on the live layout editor: forces the real, on-screen textbox visible (even if
 * the extension is otherwise disabled) and lets the user drag/resize its name/dialogue
 * areas directly. Placeholder text is shown if nothing is currently playing.
 */
function enterTextboxEditMode() {
	const active = getActiveProfile();
	if (!active) {
		toastr.warning("Add or select a textbox first.", "Prome Textbox");
		return;
	}

	editModeActive = true;
	applyCustomTextboxMode();

	if (!currentSequence.length) {
		$("#prome-textbox-name-text").text("Character Name");
		$("#prome-textbox-dialogue-text").text(
			"This is a preview of the dialogue text. Drag the boxes to move them, drag the corner handle to resize.",
		);
	}

	updateEditButtonLabel();
}

/** Turns off the live layout editor and restores normal playback/visibility state. */
function exitTextboxEditMode() {
	editModeActive = false;

	if (!currentSequence.length) {
		$("#prome-textbox-name-text").text("");
		$("#prome-textbox-dialogue-text").text("");
	}

	applyCustomTextboxMode();
	updateEditButtonLabel();
}

function onTextboxEdit_Click() {
	if (editModeActive) {
		exitTextboxEditMode();
	} else {
		enterTextboxEditMode();
	}
}

/* ---------------------------------------------------------------------- */
/* Settings UI                                                            */
/* ---------------------------------------------------------------------- */

function refreshTextboxProfileSelect() {
	const $select = $("#prome-textbox-profile-select");
	const profiles = getProfiles();

	$select.empty();
	$select.append(
		$("<option></option>")
			.val("")
			.text(profiles.length ? "Select a textbox..." : "No textboxes yet - click Add"),
	);

	for (const profile of profiles) {
		$select.append($("<option></option>").val(profile.id).text(profile.name));
	}

	const hasActive = profiles.some((profile) => profile.id === settings().activeTextboxId);
	$select.val(hasActive ? settings().activeTextboxId : "");

	if (!hasActive && settings().activeTextboxId) {
		settings().activeTextboxId = null;
		saveSettingsDebounced();
	}

	updateProfileControlsState();
}

function updateProfileControlsState() {
	const active = getActiveProfile();
	$("#prome-textbox-name-input").val(active?.name ?? "").prop("disabled", !active);
	$("#prome-textbox-edit").toggleClass("disabled", !active);
	$("#prome-textbox-delete").toggleClass("disabled", !active);
}

function onCustomTextboxEnable_Click(event) {
	settings().customTextboxEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onTextboxProfileSelect_Change(event) {
	if (editModeActive) exitTextboxEditMode();
	settings().activeTextboxId = String($(event.target).val()) || null;
	saveSettingsDebounced();
	updateProfileControlsState();
	refreshAreaStyleControls();
	applyCustomTextboxMode();
}

async function onTextboxAdd_Click() {
	$("#prome-textbox-file-input").trigger("click");
}

async function onTextboxFile_Change(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (!file) return;

	toastr.info("Uploading textbox image...", "Prome Textbox");

	try {
		const imageUrl = await uploadTextboxImage(file);
		const name = file.name.replace(/\.[^/.]+$/, "") || `Textbox ${getProfiles().length + 1}`;
		const profile = createDefaultProfile(name, imageUrl);

		getProfiles().push(profile);
		settings().activeTextboxId = profile.id;
		saveSettingsDebounced();

		refreshTextboxProfileSelect();
		refreshAreaStyleControls();
		toastr.success("Textbox uploaded! Drag the boxes on the textbox to position them.", "Prome Textbox");

		enterTextboxEditMode();
	} catch (err) {
		console.error(`[${extensionName}] Failed to upload textbox image:`, err);
		toastr.error(`Could not upload the image: ${err.message}`, "Prome Textbox");
	}
}

function onTextboxName_Input(event) {
	const active = getActiveProfile();
	if (!active) return;
	active.name = String($(event.target).val());
	saveSettingsDebounced();
	refreshTextboxProfileSelect();
}

function onTextboxDelete_Click() {
	const active = getActiveProfile();
	if (!active) return;

	if (!confirm(`Delete the textbox "${active.name}"? This cannot be undone.`)) return;

	if (editModeActive) exitTextboxEditMode();

	settings().textboxProfiles = getProfiles().filter((profile) => profile.id !== active.id);
	settings().activeTextboxId = null;
	saveSettingsDebounced();

	refreshTextboxProfileSelect();
	refreshAreaStyleControls();
	applyCustomTextboxMode();
}

function onTextboxScale_Input(event) {
	const value = clamp(Number($(event.target).val()) || 100, 50, 200);
	settings().textboxScale = value;
	$("#prome-textbox-scale").val(value);
	$("#prome-textbox-scale-counter").val(value);
	saveSettingsDebounced();
	applyScale();
}

function onTextboxAutoAdvance_Click(event) {
	const checked = Boolean($(event.target).prop("checked"));
	settings().textboxAutoAdvance = checked;
	$("#prome-textbox-auto-advance-delay").prop("disabled", !checked);
	saveSettingsDebounced();
}

function onTextboxAutoAdvanceDelay_Input(event) {
	const value = Math.max(100, Number($(event.target).val()) || 100);
	settings().textboxAutoAdvanceDelay = value;
	saveSettingsDebounced();
}

function onTextboxStreaming_Click(event) {
	const checked = Boolean($(event.target).prop("checked"));
	settings().textboxTextStreaming = checked;
	$("#prome-textbox-streaming-speed").prop("disabled", !checked);
	saveSettingsDebounced();
}

function onTextboxStreamingSpeed_Input(event) {
	const value = Math.max(1, Number($(event.target).val()) || 1);
	settings().textboxStreamingSpeed = value;
	saveSettingsDebounced();
}

function onTextboxResetPosition_Click() {
	settings().textboxPosition = null;
	saveSettingsDebounced();
	restorePosition();
}

function onTextboxPreview_Click() {
	if (!settings().customTextboxEnabled || !getActiveProfile()) {
		toastr.warning("Enable the custom textbox and select a textbox first.", "Prome Textbox");
		return;
	}

	playSequenceInTextbox(
		[
			{ text_segment: "This is a preview of your custom textbox.", expression: null, background: null, cg: null },
			{ text_segment: "Click the textbox (or wait, if auto-advance is on) to see the next segment!", expression: null, background: null, cg: null },
		],
		"Preview Character",
	);
}

/**
 * Reads the current value of a style control input/picker (number, checkbox, text, or a
 * <toolcool-color-picker>) into the right JS type for its profile field.
 */
function readStyleControlValue($input, field, event) {
	if (field === "fontColor" || field === "outlineColor") {
		return event?.detail?.rgba ?? $input.attr("color");
	}
	if ($input.attr("type") === "checkbox") {
		return Boolean($input.prop("checked"));
	}
	if ($input.attr("type") === "number") {
		return Number($input.val()) || 0;
	}
	return String($input.val());
}

function onAreaStyleControl_Change(event) {
	const active = getActiveProfile();
	if (!active) return;

	const $input = $(event.currentTarget);
	const areaKey = $input.data("area");
	const field = $input.data("field");
	const area = active[areaKey];
	if (!area) return;

	area[field] = readStyleControlValue($input, field, event);
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

/** Populates all font/style controls in the settings panel from the active profile. */
function refreshAreaStyleControls() {
	const active = getActiveProfile();
	$("#prome-textbox-style-controls").toggle(Boolean(active));
	if (!active) return;

	for (const areaKey of ["nameArea", "dialogueArea"]) {
		const area = active[areaKey];
		$(`[data-area="${areaKey}"][data-field="fontFamily"]`).val(area.fontFamily);
		$(`[data-area="${areaKey}"][data-field="fontSize"]`).val(area.fontSize);
		$(`[data-area="${areaKey}"][data-field="fontColor"]`).attr("color", area.fontColor);
		$(`[data-area="${areaKey}"][data-field="bold"]`).prop("checked", Boolean(area.bold));
		$(`[data-area="${areaKey}"][data-field="italic"]`).prop("checked", Boolean(area.italic));
		$(`[data-area="${areaKey}"][data-field="shadow"]`).prop("checked", Boolean(area.shadow));
		$(`[data-area="${areaKey}"][data-field="outlineColor"]`).attr("color", area.outlineColor);
		$(`[data-area="${areaKey}"][data-field="outlineWidth"]`).val(area.outlineWidth);
	}
	$('[data-area="nameArea"][data-field="enabled"]').prop("checked", Boolean(active.nameArea.enabled));
}

/**
 * Populates the Custom Textbox settings UI from the current extension settings.
 */
export function setupCustomTextboxHTML() {
	$("#prome-textbox-enable").prop("checked", settings().customTextboxEnabled);
	$("#prome-textbox-scale").val(settings().textboxScale);
	$("#prome-textbox-scale-counter").val(settings().textboxScale);
	$("#prome-textbox-auto-advance").prop("checked", settings().textboxAutoAdvance);
	$("#prome-textbox-auto-advance-delay")
		.val(settings().textboxAutoAdvanceDelay)
		.prop("disabled", !settings().textboxAutoAdvance);
	$("#prome-textbox-streaming").prop("checked", settings().textboxTextStreaming);
	$("#prome-textbox-streaming-speed")
		.val(settings().textboxStreamingSpeed)
		.prop("disabled", !settings().textboxTextStreaming);

	refreshTextboxProfileSelect();
	refreshAreaStyleControls();
	applyCustomTextboxMode();
}

/**
 * Binds the Custom Textbox settings UI event handlers and sets up the on-screen
 * draggable textbox element.
 */
export function setupCustomTextboxJQuery() {
	injectCustomTextboxElement();

	$("#prome-textbox-enable").on("click", onCustomTextboxEnable_Click);
	$("#prome-textbox-profile-select").on("change", onTextboxProfileSelect_Change);
	$("#prome-textbox-add").on("click", onTextboxAdd_Click);
	$("#prome-textbox-file-input").on("change", onTextboxFile_Change);
	$("#prome-textbox-name-input").on("input", onTextboxName_Input);
	$("#prome-textbox-edit").on("click", onTextboxEdit_Click);
	$("#prome-textbox-delete").on("click", onTextboxDelete_Click);
	$("#prome-textbox-scale").on("input", onTextboxScale_Input);
	$("#prome-textbox-scale-counter").on("input", onTextboxScale_Input);
	$("#prome-textbox-auto-advance").on("click", onTextboxAutoAdvance_Click);
	$("#prome-textbox-auto-advance-delay").on("input", onTextboxAutoAdvanceDelay_Input);
	$("#prome-textbox-streaming").on("click", onTextboxStreaming_Click);
	$("#prome-textbox-streaming-speed").on("input", onTextboxStreamingSpeed_Input);
	$("#prome-textbox-reset-position").on("click", onTextboxResetPosition_Click);
	$("#prome-textbox-preview").on("click", onTextboxPreview_Click);

	$("[data-area][data-field]").on("input change", onAreaStyleControl_Change);

	$(document).on("click", "#prome-custom-textbox", (event) => {
		if (editModeActive) return;
		if ($(event.target).closest("#prome-textbox-drag-handle").length) return;
		onTextboxClick();
	});

	makeDraggable($("#prome-custom-textbox"), $("#prome-textbox-drag-handle"));
	setupLiveAreaDragResize("nameArea");
	setupLiveAreaDragResize("dialogueArea");
}
