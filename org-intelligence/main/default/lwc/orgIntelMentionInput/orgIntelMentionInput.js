import { LightningElement, api } from "lwc";
import { initials } from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";

// Actions Apex du module (via le contrôleur générique du socle)
const searchUsers = moduleAction("recommendations", "searchUsers");

const SEARCH_DELAY_MS = 200;

/**
 * Zone de commentaire avec @mentions. Taper « @ » puis quelques lettres propose les utilisateurs
 * actifs ; la mention choisie devient une vraie mention Chatter (la personne est notifiée).
 * Événement « post » : { text, mentions: [{ id, name }] }.
 */
export default class OrgIntelMentionInput extends LightningElement {
  @api placeholder = "Write a comment… Type @ to mention someone";
  @api buttonLabel = "Comment";
  @api busy = false;

  text = "";
  mentions = [];
  suggestions = [];
  activeIndex = 0;
  mentionStart = -1;
  searchTimer;

  disconnectedCallback() {
    clearTimeout(this.searchTimer);
  }

  @api
  reset() {
    this.text = "";
    this.mentions = [];
    this.closeSuggestions();
    const area = this.textarea;
    if (area) {
      area.value = "";
    }
  }

  @api
  focus() {
    this.textarea?.focus();
  }

  get textarea() {
    return this.template.querySelector("textarea");
  }

  get hasSuggestions() {
    return this.suggestions.length > 0;
  }

  get suggestionItems() {
    return this.suggestions.map((user, index) => ({
      ...user,
      initials: initials(user.name),
      className: `suggestion${index === this.activeIndex ? " suggestion-active" : ""}`,
      selected: index === this.activeIndex ? "true" : "false"
    }));
  }

  get postDisabled() {
    return this.busy || !this.text.trim();
  }

  get mentionChips() {
    return this.mentions.filter((mention) =>
      this.text.includes(`@${mention.name}`)
    );
  }

  get hasMentionChips() {
    return this.mentionChips.length > 0;
  }

  handleInput(event) {
    this.text = event.target.value;
    const caret = event.target.selectionStart;
    const before = this.text.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    if (!match) {
      this.closeSuggestions();
      return;
    }
    this.mentionStart = caret - match[2].length - 1;
    const term = match[2];
    clearTimeout(this.searchTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.searchTimer = setTimeout(() => this.search(term), SEARCH_DELAY_MS);
  }

  async search(term) {
    try {
      this.suggestions = await searchUsers({ term });
      this.activeIndex = 0;
    } catch {
      this.suggestions = [];
    }
  }

  handleKeyDown(event) {
    if (this.hasSuggestions) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        this.activeIndex =
          (this.activeIndex + step + this.suggestions.length) %
          this.suggestions.length;
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        this.choose(this.suggestions[this.activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        this.closeSuggestions();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.handlePost();
    }
  }

  handleSuggestionMouseDown(event) {
    // mousedown plutôt que click : la zone de texte ne perd pas le focus avant la sélection
    event.preventDefault();
    const user = this.suggestions.find(
      (item) => item.id === event.currentTarget.dataset.id
    );
    this.choose(user);
  }

  choose(user) {
    if (!user) {
      return;
    }
    const area = this.textarea;
    const caret = area.selectionStart;
    const insertion = `@${user.name} `;
    this.text =
      this.text.slice(0, this.mentionStart) +
      insertion +
      this.text.slice(caret);
    area.value = this.text;
    const position = this.mentionStart + insertion.length;
    area.setSelectionRange(position, position);
    if (!this.mentions.some((mention) => mention.id === user.id)) {
      this.mentions = [...this.mentions, { id: user.id, name: user.name }];
    }
    this.closeSuggestions();
    area.focus();
  }

  closeSuggestions() {
    this.suggestions = [];
    this.mentionStart = -1;
    clearTimeout(this.searchTimer);
  }

  handleBlur() {
    // laisse le temps à un clic sur une suggestion
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => this.closeSuggestions(), 150);
  }

  handlePost() {
    if (this.postDisabled) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("post", {
        detail: { text: this.text.trim(), mentions: this.mentionChips }
      })
    );
  }
}
