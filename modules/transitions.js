import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../constants.js";

/*
 * Transitions
 * -----------
 * Lightweight fade transitions applied to the two things Prome changes on-screen
 * between segments: the character sprite and the scene background.
 *
 * Neither of these is fully under Prome's control at the DOM level - sprites are
 * swapped by SillyTavern's own expression system (`sendExpressionCall`) and the
 * background is a plain `#bg1` div whose `background-image` can be set from several
 * places (Prome's own segment playback, ST's native background switching, etc.).
 * Rather than hooking every call site, a single MutationObserver watches for the
 * underlying DOM changes (`src` on sprite `<img>`s, `style` on `#bg1`) and fades the
 * element in whenever it notices a change - this works no matter what triggered it.
 */

let transitionObserver = null;
let lastBackgroundImage = null;

function settings() {
	return extension_settings[extensionName];
}

function isSpriteImage(node) {
	return (
		node instanceof HTMLImageElement &&
		Boolean(node.closest("#expression-holder, [id^='expression-']"))
	);
}

/**
 * Briefly drops an element's opacity to 0, then transitions it back to 1 over
 * `duration` ms - a simple, reliable "fade in the new content" effect that doesn't
 * require knowing what the previous content looked like.
 * @param {HTMLElement} element
 * @param {number} duration - fade duration in ms
 */
function fadeIn(element, duration) {
	if (!(duration > 0)) return;

	element.style.transition = "none";
	element.style.opacity = "0";

	// Force the opacity:0 to apply before re-enabling the transition, otherwise the
	// browser may coalesce both style writes into a single frame and skip the fade.
	requestAnimationFrame(() => {
		element.style.transition = `opacity ${duration}ms ease`;
		requestAnimationFrame(() => {
			element.style.opacity = "1";
		});
	});
}

function handleSpriteChange(img) {
	if (!settings().transitionsEnabled || settings().spriteTransitionType === "none") return;
	fadeIn(img, Math.max(0, Number(settings().spriteTransitionDuration) || 0));
}

function handleBackgroundChange(bgElement) {
	const currentImage = bgElement.style.backgroundImage;
	if (currentImage === lastBackgroundImage) return;
	lastBackgroundImage = currentImage;

	if (!settings().transitionsEnabled || settings().backgroundTransitionType === "none") return;
	fadeIn(bgElement, Math.max(0, Number(settings().backgroundTransitionDuration) || 0));
}

/**
 * Starts watching sprite images and the scene background for changes, fading each one
 * in whenever it changes (only while transitions are enabled). Safe to call multiple
 * times - only sets up the observer once.
 */
export function observeTransitions() {
	if (transitionObserver) return;

	transitionObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== "attributes") continue;
			const target = mutation.target;

			if (mutation.attributeName === "src" && isSpriteImage(target)) {
				handleSpriteChange(target);
			} else if (mutation.attributeName === "style" && target.id === "bg1") {
				handleBackgroundChange(target);
			}
		}
	});

	transitionObserver.observe(document.body, {
		attributes: true,
		attributeFilter: ["src", "style"],
		subtree: true,
	});
}

/* ---------------------------------------------------------------------- */
/* Settings UI                                                            */
/* ---------------------------------------------------------------------- */

function onTransitionsEnable_Click(event) {
	settings().transitionsEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
}

function onSpriteTransitionType_Change(event) {
	settings().spriteTransitionType = String($(event.target).val());
	saveSettingsDebounced();
}

function onSpriteTransitionDuration_Input(event) {
	const value = Math.max(0, Number($(event.target).val()) || 0);
	settings().spriteTransitionDuration = value;
	$("#prome-sprite-transition-duration").val(value);
	$("#prome-sprite-transition-duration-counter").val(value);
	saveSettingsDebounced();
}

function onBackgroundTransitionType_Change(event) {
	settings().backgroundTransitionType = String($(event.target).val());
	saveSettingsDebounced();
}

function onBackgroundTransitionDuration_Input(event) {
	const value = Math.max(0, Number($(event.target).val()) || 0);
	settings().backgroundTransitionDuration = value;
	$("#prome-background-transition-duration").val(value);
	$("#prome-background-transition-duration-counter").val(value);
	saveSettingsDebounced();
}

/**
 * Populates the Transitions settings UI from the current extension settings.
 */
export function setupTransitionsHTML() {
	$("#prome-transitions-enable").prop("checked", settings().transitionsEnabled);
	$("#prome-sprite-transition-type").val(settings().spriteTransitionType);
	$("#prome-sprite-transition-duration").val(settings().spriteTransitionDuration);
	$("#prome-sprite-transition-duration-counter").val(settings().spriteTransitionDuration);
	$("#prome-background-transition-type").val(settings().backgroundTransitionType);
	$("#prome-background-transition-duration").val(settings().backgroundTransitionDuration);
	$("#prome-background-transition-duration-counter").val(settings().backgroundTransitionDuration);
}

/**
 * Binds the Transitions settings UI event handlers and starts the DOM observer that
 * applies the fades.
 */
export function setupTransitionsJQuery() {
	observeTransitions();

	$("#prome-transitions-enable").on("click", onTransitionsEnable_Click);
	$("#prome-sprite-transition-type").on("change", onSpriteTransitionType_Change);
	$("#prome-sprite-transition-duration").on("input", onSpriteTransitionDuration_Input);
	$("#prome-sprite-transition-duration-counter").on("input", onSpriteTransitionDuration_Input);
	$("#prome-background-transition-type").on("change", onBackgroundTransitionType_Change);
	$("#prome-background-transition-duration").on("input", onBackgroundTransitionDuration_Input);
	$("#prome-background-transition-duration-counter").on("input", onBackgroundTransitionDuration_Input);
}
