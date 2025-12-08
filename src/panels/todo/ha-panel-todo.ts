import { ResizeController } from "@lit-labs/observers/resize-controller";
import {
  mdiChevronDown,
  mdiChevronLeft,
  mdiClock,
  mdiCommentProcessingOutline,
  mdiDelete,
  mdiDotsVertical,
  mdiInformationOutline,
  mdiLabelOutline,
  mdiPlus,
} from "@mdi/js";
import type { CSSResultGroup, PropertyValues, TemplateResult } from "lit";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators";
import memoizeOne from "memoize-one";
import { isComponentLoaded } from "../../common/config/is_component_loaded";
import { storage } from "../../common/decorators/storage";
import { fireEvent } from "../../common/dom/fire_event";
import { computeStateName } from "../../common/entity/compute_state_name";
import { supportsFeature } from "../../common/entity/supports-feature";
import { navigate } from "../../common/navigate";
import { constructUrlCurrentPath } from "../../common/url/construct-url";
import {
  createSearchParam,
  extractSearchParam,
} from "../../common/url/search-params";
import "../../components/ha-button";
import "../../components/ha-checkbox";
import "../../components/ha-fab";
import "../../components/ha-icon-button";
import "../../components/ha-list";
import "../../components/ha-list-item";
import "../../components/ha-menu-button";
import "../../components/ha-state-icon";
import "../../components/ha-svg-icon";
import "../../components/ha-two-pane-top-app-bar-fixed";
import { deleteConfigEntry } from "../../data/config_entries";
import { getExtendedEntityRegistryEntry } from "../../data/entity_registry";
import { fetchIntegrationManifest } from "../../data/integration";
import type { LovelaceCardConfig } from "../../data/lovelace/config/card";
import {
  TodoListEntityFeature,
  getTodoLists,
  subscribeItems,
} from "../../data/todo";
import { showConfigFlowDialog } from "../../dialogs/config-flow/show-dialog-config-flow";
import {
  showAlertDialog,
  showConfirmationDialog,
} from "../../dialogs/generic/show-dialog-box";
import { showVoiceCommandDialog } from "../../dialogs/voice-command-dialog/show-ha-voice-command-dialog";
import { haStyle } from "../../resources/styles";
import type { HomeAssistant } from "../../types";
import "../lovelace/cards/hui-card";
import { showTodoItemEditDialog } from "./show-dialog-todo-item-editor";

@customElement("ha-panel-todo")
class PanelTodo extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ type: Boolean, reflect: true }) public narrow = false;

  @property({ type: Boolean, reflect: true }) public mobile = false;

  @state()
  @storage({
    key: "selectedTodoEntity",
    state: true,
  })
  private _entityId?: string;

  private _headerHeight = 56;

  private _summaryItems: Record<string, any[]> = {};

  private _summaryUnsub: (() => void)[] = [];

  private _showPaneController = new ResizeController(this, {
    callback: (entries) => entries[0]?.contentRect.width > 750,
  });

  private _mql?: MediaQueryList;

  private _conversation = memoizeOne((_components) =>
    isComponentLoaded(this.hass, "conversation")
  );

  // Labels state
  @state() private _labelsEntityId?: string; // which list labels belong to

  @state() private _labels: string[] = [];

  @state() private _selectedLabel: string | null = null;

  @state() private _labelItems: any[] = [];

  @state() private _allLabelItems: any[] = [];

  private _labelsUnsub: (() => void)[] = [];

  private _labelsItemsByEntity: Record<string, any[]> = {};

  public connectedCallback() {
    super.connectedCallback();
    this._mql = window.matchMedia(
      "(max-width: 450px), all and (max-height: 500px)"
    );
    this._mql.addEventListener("change", this._setIsMobile);
    this.mobile = this._mql.matches;
    const computedStyles = getComputedStyle(this);
    this._headerHeight = Number(
      computedStyles.getPropertyValue("--header-height").replace("px", "")
    );
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this._mql?.removeEventListener("change", this._setIsMobile!);
    this._mql = undefined;
  }

  private _setIsMobile = (ev: MediaQueryListEvent) => {
    this.mobile = ev.matches;
  };

  protected willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);

    if (!this.hasUpdated) {
      this.hass.loadFragmentTranslation("lovelace");

      const urlEntityId = extractSearchParam("entity_id");

      if (urlEntityId === "todo.summary" || urlEntityId === "todo.labels") {
        // Special synthetic views
        this._entityId = urlEntityId;

        if (urlEntityId === "todo.labels" && !this._labelsEntityId) {
          // Default base list for labels if opened directly
          this._labelsEntityId = getTodoLists(this.hass)[0]?.entity_id;
        }
      } else if (urlEntityId) {
        this._entityId = urlEntityId;
      } else {
        if (
          this._entityId &&
          this._entityId !== "todo.summary" &&
          this._entityId !== "todo.labels" &&
          !(this._entityId in this.hass.states)
        ) {
          this._entityId = undefined;
        }
        if (!this._entityId) {
          this._entityId = getTodoLists(this.hass)[0]?.entity_id;
        }
      }
    }

    if (changedProperties.has("_entityId") || !this.hasUpdated) {
      // Reset labels state when leaving labels mode
      if (this._entityId !== "todo.labels") {
        this._labels = [];
        this._selectedLabel = null;
        this._labelItems = [];
        this._labelsEntityId = undefined;
        this._allLabelItems = [];
        this._labelsUnsub.forEach((unsub) => unsub());
        this._labelsUnsub = [];
        this._labelsItemsByEntity = {};
      }
      this._setupTodoElement();

      // Ensure summary subscriptions if we just switched to summary
      if (this._entityId === "todo.summary") {
        this._subscribeAllLists();
      }

      if (this._entityId === "todo.labels") {
        this._subscribeLabelsAllLists();
      }
    }
  }

  private _setupTodoElement(): void {
    if (this._entityId === "todo.summary" || this._entityId === "todo.labels") {
      navigate(
        constructUrlCurrentPath(
          createSearchParam({ entity_id: this._entityId })
        ),
        { replace: true }
      );
      return;
    }
    if (!this._entityId) {
      this._entityId = getTodoLists(this.hass)[0]?.entity_id;
    }
    navigate(
      constructUrlCurrentPath(createSearchParam({ entity_id: this._entityId })),
      { replace: true }
    );
  }

  private _cardConfig = memoizeOne(
    (entityId: string) =>
      ({
        type: "todo-list",
        entity: entityId,
      }) as LovelaceCardConfig
  );

  protected render(): TemplateResult {
    const entityRegistryEntry =
      this._entityId &&
      this._entityId !== "todo.summary" &&
      this._entityId !== "todo.labels"
        ? this.hass.entities[this._entityId]
        : undefined;

    const entityState =
      this._entityId &&
      this._entityId !== "todo.summary" &&
      this._entityId !== "todo.labels"
        ? this.hass.states[this._entityId]
        : undefined;

    const showPane = this._showPaneController.value ?? !this.narrow;
    const todoLists = getTodoLists(this.hass);

    const listItems = [
      todoLists.map(
        (list) =>
          html`<ha-list-item
            graphic="icon"
            @click=${this._handleEntityPicked}
            .entityId=${list.entity_id}
            .activated=${list.entity_id === this._entityId}
          >
            <ha-state-icon
              .stateObj=${list}
              .hass=${this.hass}
              slot="graphic"
            ></ha-state-icon>
            ${list.name}
          </ha-list-item>`
      ),
      html`<ha-list-item
        graphic="icon"
        @click=${this._handleEntityPicked}
        data-entity-id="todo.summary"
        .entityId=${"todo.summary"}
        .activated=${this._entityId === "todo.summary"}
      >
        <ha-svg-icon
          slot="graphic"
          .path=${mdiInformationOutline}
        ></ha-svg-icon>
        Summary of Tasks
      </ha-list-item>`,
      this.hass.user?.is_admin
        ? html`<ha-list-item
            graphic="icon"
            @click=${this._showLabels}
            data-entity-id="todo.labels"
            .entityId=${"todo.labels"}
            .activated=${this._entityId === "todo.labels"}
          >
            <ha-svg-icon slot="graphic" .path=${mdiLabelOutline}></ha-svg-icon>
            Labels
          </ha-list-item>`
        : nothing,
    ];

    const headerTitle =
      this._entityId === "todo.summary"
        ? "Summary of Tasks"
        : this._entityId === "todo.labels"
          ? this.hass.localize("ui.panel.todo.labels" as any) || "Labels"
          : this._entityId
            ? entityState
              ? computeStateName(entityState)
              : this._entityId
            : "";

    return html`
      <ha-two-pane-top-app-bar-fixed
        .pane=${showPane}
        footer
        .narrow=${this.narrow}
      >
        <ha-menu-button
          slot="navigationIcon"
          .hass=${this.hass}
          .narrow=${this.narrow}
        ></ha-menu-button>
        <div slot="title">
          ${!showPane
            ? html`<ha-button-menu
                class="lists"
                activatable
                fixed
                .noAnchor=${this.mobile}
                .y=${this.mobile
                  ? this._headerHeight / 2
                  : this._headerHeight / 4}
                .x=${this.mobile ? 0 : undefined}
              >
                <ha-button slot="trigger">
                  <div>${headerTitle}</div>
                  <ha-svg-icon slot="end" .path=${mdiChevronDown}></ha-svg-icon>
                </ha-button>
                ${listItems}
                ${this.hass.user?.is_admin
                  ? html`<li divider role="separator"></li>
                      <ha-list-item graphic="icon" @click=${this._addList}>
                        <ha-svg-icon
                          .path=${mdiPlus}
                          slot="graphic"
                        ></ha-svg-icon>
                        ${this.hass.localize("ui.panel.todo.create_list")}
                      </ha-list-item>`
                  : nothing}
              </ha-button-menu>`
            : headerTitle}
        </div>
        <ha-list slot="pane" activatable>${listItems}</ha-list>
        ${showPane && this.hass.user?.is_admin
          ? html`<ha-list-item
              graphic="icon"
              slot="pane-footer"
              @click=${this._addList}
            >
              <ha-svg-icon .path=${mdiPlus} slot="graphic"></ha-svg-icon>
              ${this.hass.localize("ui.panel.todo.create_list")}
            </ha-list-item>`
          : nothing}
        <ha-button-menu slot="actionItems">
          <ha-icon-button
            slot="trigger"
            .label=${""}
            .path=${mdiDotsVertical}
          ></ha-icon-button>
          ${this._conversation(this.hass.config.components)
            ? html`<ha-list-item
                graphic="icon"
                @click=${this._showMoreInfoDialog}
                .disabled=${!this._entityId ||
                this._entityId === "todo.summary" ||
                this._entityId === "todo.labels"}
              >
                <ha-svg-icon .path=${mdiInformationOutline} slot="graphic">
                </ha-svg-icon>
                ${this.hass.localize("ui.panel.todo.information")}
              </ha-list-item>`
            : nothing}
          <li divider role="separator"></li>
          <ha-list-item graphic="icon" @click=${this._showVoiceCommandDialog}>
            <ha-svg-icon .path=${mdiCommentProcessingOutline} slot="graphic">
            </ha-svg-icon>
            ${this.hass.localize("ui.panel.todo.assist")}
          </ha-list-item>
          ${entityRegistryEntry?.platform === "local_todo"
            ? html` <li divider role="separator"></li>
                <ha-list-item
                  graphic="icon"
                  @click=${this._deleteList}
                  class="warning"
                  .disabled=${!this._entityId}
                >
                  <ha-svg-icon
                    .path=${mdiDelete}
                    slot="graphic"
                    class="warning"
                  >
                  </ha-svg-icon>
                  ${this.hass.localize("ui.panel.todo.delete_list")}
                </ha-list-item>`
            : nothing}
        </ha-button-menu>
        <div id="columns">
          <div class="column">${this._renderMainView()}</div>
        </div>
        ${entityState &&
        supportsFeature(entityState, TodoListEntityFeature.CREATE_TODO_ITEM) &&
        this._entityId !== "todo.summary" &&
        this._entityId !== "todo.labels"
          ? html`<ha-fab
              .label=${this.hass.localize("ui.panel.todo.add_item")}
              extended
              @click=${this._addItem}
            >
              <ha-svg-icon slot="icon" .path=${mdiPlus}></ha-svg-icon>
            </ha-fab>`
          : nothing}
      </ha-two-pane-top-app-bar-fixed>
    `;
  }

  private _renderMainView(): TemplateResult | typeof nothing {
    if (this._entityId === "todo.summary") {
      return this._renderSummary();
    }
    if (this._entityId === "todo.labels") {
      return this._selectedLabel
        ? this._renderLabelItemsView()
        : this._renderLabelsView();
    }
    if (!this._entityId) {
      return nothing;
    }
    return html`
      <hui-card
        .hass=${this.hass}
        .config=${this._cardConfig(this._entityId)}
      ></hui-card>
    `;
  }

  private _handleEntityPicked(ev: Event) {
    const picked = (ev.currentTarget as any).dataset.entityId;
    if (picked === "todo.summary") {
      this._entityId = "todo.summary";
      return;
    }
    if (picked === "todo.labels") {
      this._entityId = "todo.labels";
      return;
    }
    this._entityId = (ev.currentTarget as any).entityId;
  }

  private _renderLabelsView(): TemplateResult {
    const labels = this._labels;

    return html`
      <div class="labels-column">
        <h3 class="labels-title">
          ${this.hass.localize("ui.panel.todo.labels" as any) || "Labels"}
        </h3>

        ${labels.length
          ? html`
              <ha-list>
                ${labels.map(
                  (label) => html`
                    <ha-list-item
                      graphic="icon"
                      hasMeta
                      .labelValue=${label}
                      @click=${this._onLabelRowClick}
                    >
                      <ha-svg-icon
                        slot="graphic"
                        .path=${mdiLabelOutline}
                      ></ha-svg-icon>
                      <span class="label-name">${label}</span>
                    </ha-list-item>
                  `
                )}
              </ha-list>
            `
          : html`<div class="labels-empty">
              No labels available for this list.
            </div>`}
      </div>
    `;
  }

  private _renderLabelItemsView(): TemplateResult | typeof nothing {
    const label = this._selectedLabel;
    if (!label) {
      return nothing;
    }

    const filtered = this._labelItems;

    return html`
      <div class="labels-column">
        <div class="label-items-header">
          <ha-icon-button
            .path=${mdiChevronLeft}
            .label=${this.hass.localize("ui.common.back") || "Back"}
            @click=${this._backToLabels}
          ></ha-icon-button>
          <h3 class="labels-title">${label}</h3>
        </div>

        ${filtered.length
          ? html`
              <ha-list>
                ${filtered.map((item) => {
                  const completed = this._isItemCompleted(item);
                  const priorityClass = this._getPriorityClass(item.priority);
                  const priorityLabel = this._getPriorityLabel(item.priority);

                  return html`
                    <ha-list-item
                      graphic="control"
                      .item=${item}
                      @click=${this._editItem}
                    >
                      <ha-checkbox
                        slot="graphic"
                        .checked=${completed}
                        disabled
                      ></ha-checkbox>
                      <div class="label-item-main">
                        <div
                          class=${`label-item-summary${completed ? " label-item-completed" : ""}`}
                        >
                          ${item.summary}
                        </div>

                        ${item.description
                          ? html`<div class="label-item-secondary description">
                              ${item.description}
                            </div>`
                          : nothing}

                        <div class="label-item-meta">
                          ${item.due
                            ? html`<div
                                  class="due ${this._isDueOverdue(item)
                                    ? "overdue"
                                    : ""}"
                                >
                                  <ha-svg-icon .path=${mdiClock}></ha-svg-icon>
                                  ${this._isDueToday(item)
                                    ? this.hass.localize(
                                        "ui.panel.lovelace.cards.todo-list.today"
                                      ) || "Today"
                                    : html`<ha-relative-time
                                        .hass=${this.hass}
                                        .datetime=${this._getDueDateTime(item)}
                                        capitalize
                                      ></ha-relative-time>`}
                                </div>
                                <br /> `
                            : nothing}
                          ${item.priority != null
                            ? html`<span
                                class="summary priority ${priorityClass}"
                              >
                                Priority: ${priorityLabel}
                              </span>`
                            : nothing}
                        </div>
                      </div>
                    </ha-list-item>
                  `;
                })}
              </ha-list>
            `
          : html`<div class="labels-empty">No items have this label.</div>`}
      </div>
    `;
  }

  private _getLabelsBaseEntityId(): string | undefined {
    if (this._labelsEntityId) {
      return this._labelsEntityId;
    }
    if (
      this._entityId &&
      this._entityId !== "todo.summary" &&
      this._entityId !== "todo.labels" &&
      this._entityId in this.hass.states
    ) {
      return this._entityId;
    }
    return getTodoLists(this.hass)[0]?.entity_id;
  }

  private _getPriorityClass(
    priority: number | string | null | undefined
  ): string {
    if (priority == null) return "priority-low";

    const p = Number(priority);
    if (isNaN(p)) {
      const str = String(priority).toLowerCase();
      if (["low", "medium", "high", "urgent"].includes(str)) {
        return `priority-${str}`;
      }
    }

    // Map official todo integration numbers (1 = urgent, 4 = low)
    switch (p) {
      case 1:
        return "priority-urgent";
      case 2:
        return "priority-high";
      case 3:
        return "priority-medium";
      case 4:
        return "priority-low";
      default:
        return "priority-low";
    }
  }

  private _getPriorityLabel(
    priority: number | string | null | undefined
  ): string {
    if (priority == null) return "Low";

    const p = Number(priority);
    if (isNaN(p)) {
      const str = String(priority).toLowerCase();
      switch (str) {
        case "urgent":
          return "Urgent";
        case "high":
          return "High";
        case "medium":
          return "Medium";
        case "low":
          return "Low";
      }
    }

    switch (p) {
      case 1:
        return "Urgent";
      case 2:
        return "High";
      case 3:
        return "Medium";
      case 4:
        return "Low";
      default:
        return "Low";
    }
  }

  private _getDueDateTime(item: any): string {
    return item.due || "";
  }

  private _isDueToday(item: any): boolean {
    const due = this._getDueDateTime(item);
    if (!due) return false;
    const hasTime = due.includes("T");
    const dueDate = new Date(hasTime ? due : due + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return (
      dueDate.getFullYear() === today.getFullYear() &&
      dueDate.getMonth() === today.getMonth() &&
      dueDate.getDate() === today.getDate()
    );
  }

  private _isDueOverdue(item: any): boolean {
    const due = this._getDueDateTime(item);
    if (!due) return false;
    const hasTime = due.includes("T");
    const dueDate = new Date(hasTime ? due : due + "T00:00:00");
    const now = new Date();
    if (hasTime) {
      return dueDate < now;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
  }

  private async _subscribeLabelsAllLists() {
    this._labelsUnsub.forEach((unsub) => unsub());
    this._labelsUnsub = [];
    this._labelsItemsByEntity = {};

    const lists = getTodoLists(this.hass);
    if (!lists.length) {
      this._labels = [];
      this._selectedLabel = null;
      this._labelItems = [];
      this._labelsEntityId = undefined;
      this._allLabelItems = [];
      return;
    }

    const currentBase =
      this._entityId &&
      this._entityId !== "todo.summary" &&
      this._entityId !== "todo.labels"
        ? this._entityId
        : lists[0]?.entity_id;

    this._labelsEntityId = currentBase;

    const promises = lists.map(async (list) => {
      const entityId = list.entity_id;

      const unsub = await subscribeItems(this.hass, entityId, (update) => {
        this._labelsItemsByEntity[entityId] = update.items || [];
        this._rebuildLabelsFromSubscribed();
      });

      return unsub;
    });

    this._labelsUnsub = await Promise.all(promises);
    this._rebuildLabelsFromSubscribed();
  }

  private _rebuildLabelsFromSubscribed() {
    const lists = getTodoLists(this.hass);
    const labelSet = new Set<string>();
    let allItems: any[] = [];

    for (const list of lists) {
      const entityId = list.entity_id;
      const entityState = this.hass.states[entityId];

      const availableLabels = (
        (entityState?.attributes?.available_labels as string[]) ?? []
      ).filter((lbl) => lbl && lbl.trim());

      for (const lbl of availableLabels) {
        const s = String(lbl).trim();
        if (s) {
          labelSet.add(s);
        }
      }

      const items = this._labelsItemsByEntity[entityId] || [];
      if (!items.length) {
        continue;
      }

      const enriched = items.map((item) => ({
        ...item,
        __entity_id: entityId,
      }));

      allItems = allItems.concat(enriched);
    }

    if (!labelSet.size && allItems.length) {
      for (const item of allItems) {
        const l = (item as any).labels;
        if (!l) {
          continue;
        }

        if (Array.isArray(l)) {
          for (const v of l) {
            const s = String(v).trim();
            if (s) {
              labelSet.add(s);
            }
          }
        } else if (typeof l === "string") {
          l.split(",")
            .map((p) => p.trim())
            .filter(Boolean)
            .forEach((s) => labelSet.add(s));
        }
      }
    }

    this._allLabelItems = allItems;
    this._labels = Array.from(labelSet);

    if (this._selectedLabel) {
      this._labelItems = this._allLabelItems.filter((item) =>
        this._itemHasLabel(item, this._selectedLabel as string)
      );
    } else {
      this._labelItems = [];
    }
  }

  private async _showLabels(): Promise<void> {
    if (this._entityId === "todo.labels") {
      return;
    }

    this._entityId = "todo.labels";
  }

  private async _onLabelRowClick(ev: Event): Promise<void> {
    const target = ev.currentTarget as any;
    const label = target.labelValue as string;

    if (!label) {
      return;
    }

    this._selectedLabel = label;
    this._labelItems = this._allLabelItems.filter((item) =>
      this._itemHasLabel(item, label)
    );
  }

  private _backToLabels(): void {
    this._selectedLabel = null;
    this._labelItems = [];
  }

  private _isItemCompleted(item: any): boolean {
    const status = String(item.status || "").toLowerCase();
    return status.includes("completed");
  }

  private _itemHasLabel(item: any, label: string): boolean {
    const target = label.trim();
    if (!target) return false;
    const raw = (item as any).labels;
    if (!raw) return false;

    if (Array.isArray(raw)) {
      return raw.some((v) => String(v).trim() === target);
    }

    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((p) => p.trim())
        .includes(target);
    }

    return false;
  }

  private _editItem(ev: Event): void {
    const target = ev.currentTarget as any;
    const item = target.item;

    if (!item) {
      return;
    }

    const entityId = (item as any).__entity_id || this._getLabelsBaseEntityId();

    if (!entityId) {
      return;
    }

    showTodoItemEditDialog(this, { entity: entityId, item });
  }

  private async _addList(): Promise<void> {
    showConfigFlowDialog(this, {
      startFlowHandler: "local_todo",
      showAdvanced: this.hass.userData?.showAdvanced,
      manifest: await fetchIntegrationManifest(this.hass, "local_todo"),
    });
  }

  private _showMoreInfoDialog(): void {
    if (
      !this._entityId ||
      this._entityId === "todo.summary" ||
      this._entityId === "todo.labels"
    ) {
      return;
    }
    fireEvent(this, "hass-more-info", { entityId: this._entityId });
  }

  private async _deleteList(): Promise<void> {
    if (
      !this._entityId ||
      this._entityId === "todo.summary" ||
      this._entityId === "todo.labels"
    ) {
      return;
    }

    const entityRegistryEntry = await getExtendedEntityRegistryEntry(
      this.hass,
      this._entityId
    );

    if (entityRegistryEntry.platform !== "local_todo") {
      return;
    }

    const entryId = entityRegistryEntry.config_entry_id;

    if (!entryId) {
      return;
    }

    const confirmed = await showConfirmationDialog(this, {
      title: this.hass.localize("ui.panel.todo.delete_confirm_title", {
        name:
          this._entityId in this.hass.states
            ? computeStateName(this.hass.states[this._entityId])
            : this._entityId,
      }),
      text: this.hass.localize("ui.panel.todo.delete_confirm_text"),
      confirmText: this.hass!.localize("ui.common.delete"),
      dismissText: this.hass!.localize("ui.common.cancel"),
      destructive: true,
    });

    if (!confirmed) {
      return;
    }
    const result = await deleteConfigEntry(this.hass, entryId);

    this._entityId = getTodoLists(this.hass)[0]?.entity_id;

    if (result.require_restart) {
      showAlertDialog(this, {
        text: this.hass.localize("ui.panel.todo.restart_confirm"),
      });
    }
  }

  private _showVoiceCommandDialog(): void {
    showVoiceCommandDialog(this, this.hass, { pipeline_id: "last_used" });
  }

  private _addItem() {
    showTodoItemEditDialog(this, { entity: this._entityId! });
  }

  private async _subscribeAllLists() {
    // Clean up old subscriptions
    this._summaryUnsub.forEach((unsub) => unsub());
    this._summaryUnsub = [];
    this._summaryItems = {};

    const lists = getTodoLists(this.hass);

    const promises = lists.map(async (list) => {
      const entityId = list.entity_id;

      const unsub = await subscribeItems(this.hass, entityId, (update) => {
        this._summaryItems[entityId] = update.items || [];
        this.requestUpdate();
      });

      return unsub;
    });

    // Wait for all subscriptions
    this._summaryUnsub = await Promise.all(promises);
  }

  private _renderSummary() {
    const lists = getTodoLists(this.hass);

    let totalNeeds = 0;
    let totalCompleted = 0;

    // Aggregate all items across all lists
    for (const list of lists) {
      const items = this._summaryItems[list.entity_id] || [];
      totalNeeds += items.filter((i) => i.status === "needs_action").length;
      totalCompleted += items.filter((i) => i.status === "completed").length;
    }

    const total = totalNeeds + totalCompleted;

    return html`
      <ha-card header="Summary of Tasks">
        <div class="dashboard-wrapper">
          <!-- TOTAL -->
          <div class="stat-card">
            <div class="circle-wrapper">
              <div class="ring total"></div>
              <div class="stat-value">${total}</div>
            </div>
            <div class="stat-label">Total Tasks</div>
          </div>

          <!-- NEEDS ACTION -->
          <div class="stat-card">
            <div class="circle-wrapper">
              <div class="ring needs"></div>
              <div class="stat-value">${totalNeeds}</div>
            </div>
            <div class="stat-label">Pending Tasks</div>
          </div>

          <!-- COMPLETED -->
          <div class="stat-card">
            <div class="circle-wrapper">
              <div class="ring completed"></div>
              <div class="stat-value">${totalCompleted}</div>
            </div>
            <div class="stat-label">Completed Tasks</div>
          </div>

          <!-- ANALYTICS PIE CHART -->
          <div class="analytics-card">
            <div class="analytics-title">Analytics</div>

            ${this._renderAnalyticsPie(totalNeeds, totalCompleted, total)}

            <!-- LEGEND -->
            <div class="legend">
              <div>
                <span style="background: var(--success-color);"></span>
                Completed Tasks: ${totalCompleted}
              </div>
              <div>
                <span style="background: var(--error-color);"></span> Pending
                Tasks: ${totalNeeds}
              </div>
            </div>
          </div>
        </div>
      </ha-card>
    `;
  }

  private _renderAnalyticsPie(
    totalNeeds: number,
    totalCompleted: number,
    total: number
  ): TemplateResult {
    const completed = totalCompleted;
    const needs = totalNeeds;
    const remainingRaw = total - completed - needs;
    const remaining = remainingRaw > 0 ? remainingRaw : 0;

    const totalSegments = completed + needs + remaining || 1;
    const pct = (v: number) => (v / totalSegments) * 100;

    const c = pct(completed);
    const n = pct(needs);
    const r = pct(remaining);

    return html`
      <svg class="pie-chart" viewBox="-3 -3 38 38">
        <circle
          r="16"
          cx="16"
          cy="16"
          fill="transparent"
          stroke="var(--success-color)"
          stroke-width="4"
          stroke-dasharray="${c} ${100 - c}"
          transform="rotate(-90 16 16)"
        />
        <circle
          r="16"
          cx="16"
          cy="16"
          fill="transparent"
          stroke="var(--error-color)"
          stroke-width="4"
          stroke-dasharray="${n} ${100 - n}"
          transform="rotate(${(c / 100) * 360 - 90} 16 16)"
        />
        <circle
          r="16"
          cx="16"
          cy="16"
          fill="transparent"
          stroke="var(--primary-color)"
          stroke-width="4"
          stroke-dasharray="${r} ${100 - r}"
          transform="rotate(${((c + n) / 100) * 360 - 90} 16 16)"
        />
      </svg>
    `;
  }

  static get styles(): CSSResultGroup {
    return [
      haStyle,
      css`
        :host {
          display: block;
        }
        #columns {
          display: flex;
          flex-direction: row;
          justify-content: center;
          margin: 8px;
          padding-bottom: 70px;
        }
        .column {
          flex: 1 0 0;
          max-width: 500px;
          min-width: 0;
        }
        :host([mobile]) .lists {
          --mdc-menu-min-width: 100vw;
        }
        :host(:not([mobile])) .lists ha-list-item {
          max-width: calc(100vw - 120px);
        }
        :host([mobile]) ha-button-menu {
          --mdc-shape-medium: 0 0 var(--mdc-shape-medium)
            var(--mdc-shape-medium);
        }
        ha-button-menu {
          max-width: 100%;
        }
        ha-button-menu ha-button div {
          text-overflow: ellipsis;
          width: 100%;
          overflow: hidden;
          white-space: nowrap;
          display: block;
        }
        ha-fab {
          position: fixed;
          right: calc(16px + var(--safe-area-inset-right, 0px));
          bottom: calc(16px + var(--safe-area-inset-bottom, 0px));
          inset-inline-end: calc(16px + var(--safe-area-inset-right, 0px));
          inset-inline-start: initial;
        }
        .dashboard-wrapper {
          display: flex;
          justify-content: space-evenly;
          align-items: flex-start;
          padding: 24px 16px 32px;
          flex-wrap: wrap;
          gap: 40px;
        }

        .stat-card,
        .analytics-card {
          position: relative;
          width: 200px;
          height: 200px;
          border-radius: 16px;
          background: var(--ha-card-background, var(--card-background-color));
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0, 0, 0, 0.16));
          display: flex;
          flex-direction: column;
          align-items: center;
          padding-top: 16px;
        }

        .circle-wrapper {
          position: relative;
          width: 120px;
          height: 120px;
          display: flex;
          justify-content: center;
          align-items: center;
        }

        .stat-value {
          font-size: 34px;
          font-weight: 600;
          color: var(--primary-text-color);
          z-index: 2;
        }

        .stat-label {
          margin-top: 12px;
          font-size: 15px;
          color: var(--secondary-text-color);
          font-weight: 500;
          text-align: center;
        }

        .ring {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 6px solid transparent;
          animation: fadeIn 0.8s ease-out forwards;
        }

        .ring.total {
          border-color: var(--primary-color);
          opacity: 0.45;
        }
        .ring.needs {
          border-color: var(--error-color);
          opacity: 0.45;
        }
        .ring.completed {
          border-color: var(--success-color);
          opacity: 0.45;
        }

        @keyframes fadeIn {
          from {
            transform: scale(0.8);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }

        .analytics-title {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--primary-text-color);
        }

        .pie-chart {
          width: 100px;
          height: 100px;
        }

        .legend {
          margin-top: 12px;
          font-size: 13px;
          text-align: left;
          width: 100%;
          padding-left: 20px;
          color: var(--secondary-text-color);
        }

        .legend div {
          display: flex;
          align-items: center;
          margin-bottom: 4px;
        }

        .legend span {
          width: 12px;
          height: 12px;
          border-radius: 3px;
          margin-right: 8px;
          display: inline-block;
        }

        .labels-column {
          max-width: 500px;
        }
        .labels-title {
          margin: 0 0 8px;
          font-size: var(--ha-font-size-l);
          font-weight: var(--ha-font-weight-medium);
        }
        .labels-empty {
          color: var(--secondary-text-color);
          font-size: var(--ha-font-size-m);
        }
        .label-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .label-items-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .label-item-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .label-item-summary {
          font-weight: var(--ha-font-weight-medium);
        }
        .label-item-completed {
          text-decoration: line-through;
          color: var(--secondary-text-color);
        }
        .label-item-secondary {
          color: var(--secondary-text-color);
          font-size: var(--ha-font-size-s);
        }
        .warning {
          color: var(--error-color);
        }
        .label-item-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 6px;
          font-size: 0.8rem;
          color: var(--secondary-text-color);
        }

        .label-item-meta span {
          opacity: 0.9;
        }

        .due-date::before {
          content: "calendar";
          margin-right: 4px;
          opacity: 0.7;
        }

        .priority {
          font-weight: 600;
        }

        .priority-1 {
          color: var(--error-color);
        }
        .priority-2 {
          color: var(--warning-color);
        }
        .priority-3 {
          color: var(--info-color);
        }
        .priority-4 {
          color: var(--success-color);
        }

        .created-date::before {
          content: "plus";
          margin-right: 4px;
          opacity: 0.7;
        }

        .description {
          margin-bottom: 4px;
        }

        .priority-urgent {
          color: #db4437 !important;
          font-weight: 600 !important;
        }
        .priority-high {
          color: #ff9800 !important;
          font-weight: 600 !important;
        }
        .priority-medium {
          color: #03a9f4 !important;
        }
        .priority-low {
          color: #b0b0b0 !important;
        }

        /* Optional: small visual tweak for consistency */
        .label-item-meta .priority {
          font-size: 1rem !important;
          font-weight: 700 !important;
          padding: 2px 6px;
          border-radius: 4px;
          letter-spacing: 0.5px;
        }

        .due {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.85rem;
          color: #ff9800 !important;
          font-weight: 500;
        }

        .due ha-svg-icon {
          width: 16px;
          height: 16px;
          --mdc-icon-size: 16px;
          color: #ff9800 !important;
        }

        .due.overdue {
          color: #ff9800 !important;
          font-weight: 600;
        }

        .due.overdue ha-svg-icon {
          color: #ff9800 !important;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-todo": PanelTodo;
  }
}
