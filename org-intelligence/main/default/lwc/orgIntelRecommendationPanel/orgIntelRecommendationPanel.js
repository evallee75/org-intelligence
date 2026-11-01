import { LightningElement, api } from "lwc";
import { NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import USER_ID from "@salesforce/user/Id";
import JiraExportModal from "c/orgIntelJiraExportModal";
import {
  REC_STATUSES,
  componentTypeLabel,
  formatDate,
  formatDateTime,
  formatRelative,
  initials,
  recStatusTone,
  reduceErrors,
  severityMeta
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  LOCAL_MODE,
  COLLABORATIVE_MODE,
  applyLocalChanges,
  getLocalRecommendation,
  isLocalId
} from "c/orgIntelRecommendationStore";

// Actions Apex du module (via le contrôleur générique du socle)
const getRecommendation = moduleAction("recommendations", "getRecommendation");
const updateRecommendations = moduleAction(
  "recommendations",
  "updateRecommendations"
);
const postComment = moduleAction("recommendations", "postComment");
const setFollowing = moduleAction("recommendations", "setFollowing");

const REASON_REQUIRED = ["Ignored", "Resolved"];

const HISTORY_ICONS = {
  Status: "utility:change_record_type",
  Severity: "utility:priority",
  "Assigned to": "utility:user",
  "Decision reason": "utility:note",
  "Due date": "utility:event",
  Created: "utility:new"
};

/**
 * Détail d'une recommandation et collaboration : décision (statut + motif), assignation, échéance,
 * discussion avec @mentions, historique (décisions et détections), suivi Chatter, export de contexte.
 *
 * Édition sans objet (identifiant « local:… ») : même écran lu dans le navigateur, sans
 * assignation, discussion ni suivi ; l'historique des décisions est gardé dans la recommandation.
 */
export default class OrgIntelRecommendationPanel extends NavigationMixin(
  LightningElement
) {
  _recordId;
  detail;
  error;
  isLoading = true;
  isSaving = false;
  isPosting = false;
  replyTo = null;

  draftStatus;
  draftReason = "";
  /** Édition sans objet : responsable (texte libre) et notes. */
  draftOwner = "";
  draftNotes = "";
  reasonOpen = false;

  userFilter = {
    criteria: [
      { fieldPath: "IsActive", operator: "eq", value: true },
      { fieldPath: "UserType", operator: "eq", value: "Standard" }
    ],
    filterLogic: "1 AND 2"
  };

  /** Modules installés : l'export de contexte exige le module Context Hub. */
  @api modules = [];

  /** Nom de l'utilisateur courant (historique des décisions locales). */
  @api userName;

  get isLocal() {
    return isLocalId(this._recordId);
  }

  get isCollaborative() {
    return !this.isLocal;
  }

  get hasContextHub() {
    return (this.modules || []).includes("contextHub");
  }

  @api
  get recordId() {
    return this._recordId;
  }
  set recordId(value) {
    const changed = value !== this._recordId;
    this._recordId = value;
    if (changed && value) {
      this.load();
    }
  }

  @api
  refresh() {
    return this.load();
  }

  async load() {
    this.isLoading = !this.detail || this.detail.record.id !== this._recordId;
    try {
      this.detail = this.isLocal
        ? await getLocalRecommendation(this._recordId)
        : await getRecommendation({ recordId: this._recordId });
      this.error = undefined;
      this.draftStatus = this.detail.record.status;
      this.draftReason = this.detail.decisionReason || "";
      this.draftOwner = this.detail.owner || "";
      this.draftNotes = this.detail.notes || "";
      this.reasonOpen = false;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  // ---------- En-tête ----------

  get rec() {
    return this.detail?.record;
  }

  get severity() {
    return severityMeta(this.rec?.severity);
  }

  /** Gravité ajustée par l'utilisateur (édition sans objet) : la gravité de la règle reste visible. */
  get severityAdjusted() {
    return !!this.rec?.severityAdjusted;
  }

  get adjustedLabel() {
    return `Rule: ${severityMeta(this.rec?.ruleSeverity).label}`;
  }

  get severityTitle() {
    return this.severityAdjusted
      ? `Severity adjusted (the rule says ${this.rec.ruleSeverity})`
      : "Severity";
  }

  get statusTone() {
    return recStatusTone(this.rec?.status);
  }

  get componentLabel() {
    return componentTypeLabel(this.rec?.componentType);
  }

  get detectionText() {
    const rec = this.rec;
    if (!rec) {
      return "";
    }
    const times =
      rec.occurrenceCount === 1 ? "once" : `${rec.occurrenceCount} times`;
    return `Detected ${times} · last ${formatRelative(rec.lastDetectedAt)}${this.detail.lastDetectedScanName ? ` (${this.detail.lastDetectedScanName})` : ""}`;
  }

  /** Faits clés de l'en-tête (liste de définitions compacte). */
  /**
   * Ligne de contexte compacte sous le titre : type, composant, catégorie, détections, dernière
   * détection (détail complet en infobulle). Remplace l'ancienne grille de faits.
   */
  get metaParts() {
    const rec = this.rec;
    if (!rec) {
      return [];
    }
    const times =
      rec.occurrenceCount === 1
        ? "Detected once"
        : rec.occurrenceCount
          ? `Detected ${rec.occurrenceCount}×`
          : null;
    const scanName = this.detail?.lastDetectedScanName;
    const parts = [
      {
        key: "component",
        value: rec.componentName,
        title: `${this.componentLabel || "Component"}: ${rec.componentName}`,
        strong: true
      },
      { key: "type", value: this.componentLabel },
      { key: "category", value: rec.category },
      {
        key: "times",
        value: times,
        title: rec.confidence ? `Confidence: ${rec.confidence}` : null
      },
      {
        key: "seen",
        value: rec.lastDetectedAt
          ? `seen ${formatRelative(rec.lastDetectedAt)}`
          : null,
        title: rec.lastDetectedAt
          ? `${formatDateTime(rec.lastDetectedAt)}${scanName ? ` · ${scanName}` : ""}`
          : null
      }
    ];
    return parts
      .filter((part) => part.value)
      .map((part, index) => ({
        ...part,
        title: part.title || String(part.value),
        className: part.strong ? "rp-meta-part rp-meta-strong" : "rp-meta-part",
        separator: index > 0
      }));
  }

  get notDetected() {
    return this.rec?.stillDetected === false && this.rec?.isOpen;
  }

  get isOverdue() {
    const due = this.rec?.dueDate;
    return !!due && this.rec.isOpen && new Date(`${due}T23:59:59`) < new Date();
  }

  get dueText() {
    return this.rec?.dueDate ? formatDate(this.rec.dueDate) : "No due date";
  }

  get canEdit() {
    return !!this.detail?.canEdit;
  }

  get jiraTitle() {
    return this.isLocal
      ? "Download a CSV file to import into Jira"
      : "Export to Jira";
  }

  get readOnly() {
    return !this.canEdit;
  }

  // ---------- Décision ----------

  get statusOptions() {
    return REC_STATUSES.map((status) => ({
      label: status.label,
      value: status.value
    }));
  }

  /** Motif affiché seulement s'il existe, si le statut change ou à la demande (gain de place). */
  get showReason() {
    return (
      this.reasonOpen ||
      !!this.draftReason ||
      this.draftStatus !== this.rec?.status
    );
  }

  get canAddReason() {
    return !this.readOnly;
  }

  handleShowReason() {
    this.reasonOpen = true;
  }

  get decisionChanged() {
    return (
      this.draftStatus !== this.rec?.status ||
      (this.draftReason || "") !== (this.detail?.decisionReason || "") ||
      (this.isLocal &&
        ((this.draftOwner || "").trim() !== (this.detail?.owner || "") ||
          (this.draftNotes || "").trim() !== (this.detail?.notes || "")))
    );
  }

  handleOwnerChange(event) {
    this.draftOwner = event.target.value || "";
  }

  handleNotesChange(event) {
    this.draftNotes = event.target.value || "";
  }

  get reasonRequired() {
    return REASON_REQUIRED.includes(this.draftStatus);
  }

  get reasonLabel() {
    return this.reasonRequired
      ? "Decision reason (required)"
      : "Decision reason";
  }

  get saveDecisionDisabled() {
    return (
      this.isSaving ||
      !this.decisionChanged ||
      (this.reasonRequired && !this.draftReason.trim())
    );
  }

  handleStatusChange(event) {
    this.draftStatus = event.detail.value;
  }

  handleReasonChange(event) {
    this.draftReason = event.target.value || "";
  }

  handleCancelDecision() {
    this.draftStatus = this.rec?.status;
    this.draftReason = this.detail?.decisionReason || "";
    this.draftOwner = this.detail?.owner || "";
    this.draftNotes = this.detail?.notes || "";
    this.reasonOpen = false;
  }

  handleSaveDecision() {
    const changes = {};
    const statusChanged =
      this.draftStatus !== this.rec?.status ||
      (this.draftReason || "") !== (this.detail?.decisionReason || "");
    if (statusChanged) {
      changes.status = this.draftStatus;
      changes.decisionReason = this.draftReason.trim();
    }
    if (this.isLocal) {
      if ((this.draftOwner || "").trim() !== (this.detail?.owner || "")) {
        changes.owner = this.draftOwner.trim();
      }
      if ((this.draftNotes || "").trim() !== (this.detail?.notes || "")) {
        changes.notes = this.draftNotes.trim();
      }
    }
    this.save(
      changes,
      statusChanged ? `Status set to ${this.draftStatus}.` : "Saved."
    );
  }

  // ---------- Assignation et échéance ----------

  get showAssignToMe() {
    return this.canEdit && this.rec?.assignedToId !== USER_ID;
  }

  get ruleLabel() {
    return this.detail?.rule?.label || this.rec?.ruleCode || "Rule";
  }

  get ruleDescription() {
    return this.detail?.rule?.description || "";
  }

  /** Description et seuil de la règle, affichés en info-bulle. */
  get ruleHelp() {
    return [this.ruleDescription, this.ruleThreshold]
      .filter((part) => !!part)
      .join(" · ");
  }

  handleAssigneeChange(event) {
    const assignedToId = event.detail.recordId || null;
    if (assignedToId === (this.rec?.assignedToId || null)) {
      return;
    }
    this.save(
      { assignedToId },
      assignedToId
        ? "Recommendation assigned. The assignee is notified and follows it."
        : "Assignment removed."
    );
  }

  handleAssignToMe() {
    this.save({ assignedToId: USER_ID }, "Recommendation assigned to you.");
  }

  handleDueDateChange(event) {
    const dueDate = event.target.value || null;
    if (dueDate === (this.rec?.dueDate || null)) {
      return;
    }
    this.save({ dueDate }, dueDate ? "Due date updated." : "Due date removed.");
  }

  async save(changes, message) {
    this.isSaving = true;
    try {
      if (this.isLocal) {
        await applyLocalChanges([this._recordId], changes, {
          userName: this.userName
        });
      } else {
        await updateRecommendations({
          recordIds: [this._recordId],
          changesJson: JSON.stringify(changes)
        });
      }
      this.toast(message, "success");
      await this.load();
      this.dispatchEvent(
        new CustomEvent("changed", { detail: { recordId: this._recordId } })
      );
    } catch (error) {
      this.toast(reduceErrors(error), "error", "Not saved");
      this.draftStatus = this.rec?.status;
    } finally {
      this.isSaving = false;
    }
  }

  // ---------- Discussion ----------

  get comments() {
    return (this.detail?.comments || []).map((comment) => this.toView(comment));
  }

  toView(comment) {
    return {
      ...comment,
      initials: initials(comment.authorName),
      when: formatRelative(comment.createdDate),
      exactDate: formatDateTime(comment.createdDate),
      parts: (comment.segments || []).map((segment, index) => ({
        key: `${comment.id}-${index}`,
        text: segment.text,
        isMention: segment.type === "mention",
        className: segment.type === "mention" ? "mention" : null
      })),
      replies: (comment.replies || []).map((reply) => this.toView(reply)),
      isReplying: this.replyTo === comment.id
    };
  }

  get commentCount() {
    return (this.detail?.comments || []).reduce(
      (total, comment) => total + 1 + (comment.replies || []).length,
      0
    );
  }

  get discussionLabel() {
    return `Discussion (${this.commentCount})`;
  }

  get hasComments() {
    return this.commentCount > 0;
  }

  async handlePost(event) {
    await this.post(event.detail, null, event.target);
  }

  async handleReplyPost(event) {
    await this.post(event.detail, event.target.dataset.parent, event.target);
  }

  async post({ text, mentions }, parentCommentId, composer) {
    this.isPosting = true;
    try {
      const comments = await postComment({
        recordId: this._recordId,
        text,
        mentionsJson: JSON.stringify(mentions),
        parentCommentId
      });
      this.detail = { ...this.detail, comments };
      composer?.reset();
      this.replyTo = null;
      this.toast(
        mentions.length
          ? `Comment posted. ${mentions.length} person(s) notified.`
          : "Comment posted.",
        "success"
      );
      this.dispatchEvent(
        new CustomEvent("changed", { detail: { recordId: this._recordId } })
      );
    } catch (error) {
      this.toast(reduceErrors(error), "error", "Comment not posted");
    } finally {
      this.isPosting = false;
    }
  }

  handleReply(event) {
    this.replyTo =
      this.replyTo === event.currentTarget.dataset.id
        ? null
        : event.currentTarget.dataset.id;
  }

  // ---------- Historique ----------

  get timeline() {
    const items = [];
    for (const entry of this.detail?.history || []) {
      const created = entry.field === "created";
      items.push({
        key: `h-${entry.changedAt}-${entry.field}-${items.length}`,
        at: entry.changedAt,
        icon: HISTORY_ICONS[entry.fieldLabel] || "utility:edit",
        title: created
          ? "Recommendation created"
          : `${entry.fieldLabel} changed`,
        detail: created
          ? null
          : `${entry.oldValue || "—"} → ${entry.newValue || "—"}`,
        who: entry.changedByName
      });
    }
    const rec = this.rec;
    if (rec?.lastDetectedAt) {
      const scanName = this.detail.lastDetectedScanName;
      items.push({
        key: "last-detected",
        at: rec.lastDetectedAt,
        icon: "utility:search",
        title: scanName ? `Last detected by ${scanName}` : "Last detected",
        detail:
          rec.occurrenceCount > 1
            ? `Detected ${rec.occurrenceCount} times in total`
            : null,
        who: null
      });
    }
    return items
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .map((item) => ({
        ...item,
        when: formatDateTime(item.at),
        relative: formatRelative(item.at)
      }));
  }

  get historyLabel() {
    return `History (${this.timeline.length})`;
  }

  // ---------- Contexte ----------

  get affected() {
    return this.detail?.affectedComponents || [];
  }

  get hasAffected() {
    return this.affected.length > 0;
  }

  get related() {
    return (this.detail?.relatedRecommendations || []).map((rec) => ({
      ...rec,
      severityLabel: severityMeta(rec.severity).label,
      severityTone: severityMeta(rec.severity).tone
    }));
  }

  get hasRelated() {
    return this.related.length > 0;
  }

  get ruleThreshold() {
    const threshold = this.detail?.rule?.threshold;
    return threshold === null || threshold === undefined
      ? null
      : `Threshold: ${threshold}`;
  }

  get followLabel() {
    return this.detail?.isFollowing ? "Following" : "Follow";
  }

  get followIcon() {
    return this.detail?.isFollowing ? "utility:check" : "utility:add";
  }

  get followVariant() {
    return this.detail?.isFollowing ? "brand-outline" : "neutral";
  }

  get followTitle() {
    return this.detail?.isFollowing
      ? "Following: updates appear in your Chatter feed. Click to unfollow."
      : "Follow: get its updates in your Chatter feed";
  }

  async handleFollow() {
    try {
      const following = await setFollowing({
        recordId: this._recordId,
        follow: !this.detail.isFollowing
      });
      this.detail = { ...this.detail, isFollowing: following };
      this.toast(
        following
          ? "You follow this recommendation: its updates appear in your Chatter feed."
          : "You no longer follow this recommendation.",
        "success"
      );
    } catch (error) {
      this.toast(reduceErrors(error), "error");
    }
  }

  handleExport() {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "contextHub", recordId: this._recordId }
      })
    );
  }

  async handleExportJira() {
    const result = await JiraExportModal.open({
      size: "medium",
      label: this.isLocal ? "Jira import file" : "Export to Jira",
      recordIds: [this._recordId],
      mode: this.isLocal ? LOCAL_MODE : COLLABORATIVE_MODE
    });
    if (result?.exported > 0) {
      this.load();
      this.dispatchEvent(
        new CustomEvent("changed", { detail: { recordId: this._recordId } })
      );
    }
  }

  handleOpenRecord(event) {
    event?.preventDefault();
    this[NavigationMixin.Navigate]({
      type: "standard__recordPage",
      attributes: { recordId: this._recordId, actionName: "view" }
    });
  }

  handleSelectRelated(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("select", {
        detail: { recordId: event.currentTarget.dataset.id }
      })
    );
  }

  handleClose() {
    this.dispatchEvent(new CustomEvent("close"));
  }

  toast(message, variant, title) {
    this.dispatchEvent(
      new ShowToastEvent({
        title: title || (variant === "success" ? "Saved" : "Error"),
        message,
        variant
      })
    );
  }
}
