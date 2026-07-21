import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../constants.js";
import { getCgImagePath } from "../utils.js";

/*
 * CGs (Full-Screen Art)
 * ----------------------
 * Shows a classified "cg" segment as a full-screen art piece (`#prome-cg-display`), the
 * same way visual novels show a special illustration during key scenes. While a CG is
 * showing, the ST shell (sheld), the character sprites and (optionally) the top bar are
 * all hidden via the `prome-cg-active`/`prome-cg-hide-topbar` body classes (see
 * style.css) - the custom textbox keeps playing dialogue on top of the art as usual.
 */

function settings() {
	return extension_settings[extensionName];
}

let cgActive = false;

function injectCgElement() {
	if ($("#prome-cg-display").length) return;

	const html = `
		<div id="prome-cg-display" class="prome-cg-display displayNone">
			<img id="prome-cg-image" class="prome-cg-image" alt="CG" />
		</div>
	`;

	$("body").append(html);
}

/**
 * Shows the given CG (by label - file name without extension in the Prome CG folder)
 * as full-screen art, hiding the sheld/sprites (and optionally the top bar) while it's
 * shown. Does nothing if no matching file is found.
 * @param {string} label - The CG label
 */
export async function showCG(label) {
	injectCgElement();

	const path = await getCgImagePath(label);
	if (!path) {
		console.warn(`[${extensionName}] CG "${label}" could not be found in the prome-cgs folder.`);
		return;
	}

	$("#prome-cg-image").attr("src", path);
	$("#prome-cg-display").removeClass("displayNone");
	cgActive = true;
	$("body").addClass("prome-cg-active");
	$("body").toggleClass("prome-cg-hide-topbar", Boolean(settings().cgHideTopBar));
}

/**
 * Hides the currently showing CG (if any) and restores normal sheld/sprite/top bar
 * visibility.
 */
export function hideCG() {
	if (!cgActive) return;

	cgActive = false;
	$("#prome-cg-display").addClass("displayNone");
	$("body").removeClass("prome-cg-active prome-cg-hide-topbar");
}

export function isCgActive() {
	return cgActive;
}

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

export function onCgHideTopBar_Click(event) {
	const value = Boolean($(event.target).prop("checked"));
	settings().cgHideTopBar = value;
	saveSettingsDebounced();
	if (cgActive) $("body").toggleClass("prome-cg-hide-topbar", value);
}

export function setupCgHTML() {
	injectCgElement();
	$("#prome-cg-hide-topbar").prop("checked", settings().cgHideTopBar);
}

export function setupCgJQuery() {
	$("#prome-cg-hide-topbar").on("click", onCgHideTopBar_Click);
}
