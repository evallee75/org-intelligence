/**
 * Graphe des automatisations d'un scan : qui se déclenche sur quel objet, à quel moment, et quels
 * objets chaque automatisation écrit. Sert à la vue Automation et à la détection des boucles
 * (objet A → automatisation → objet B → automatisation → objet A).
 *
 * Les écritures ne sont connues que pour les flows et Process Builder (définition analysée) ; le
 * code des triggers Apex n'est pas interprété.
 */
public inherited sharing class OrgAutomationGraph {
  private static final Integer MAX_CYCLE_LENGTH = 6;

  public class Automation {
    @AuraEnabled
    public String apiName;
    @AuraEnabled
    public String label;
    @AuraEnabled
    public String kind;
    @AuraEnabled
    public String objectName;
    @AuraEnabled
    public String timing;
    @AuraEnabled
    public List<String> events = new List<String>();
    @AuraEnabled
    public Boolean isActive;
    @AuraEnabled
    public Decimal apiVersion;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public String metadataId;
    @AuraEnabled
    public String versionId;
    @AuraEnabled
    public String modelJson;
    public OrgFlowAnalyzer.FlowModel model;
  }

  public class Cycle {
    @AuraEnabled
    public String key;
    @AuraEnabled
    public List<String> objects = new List<String>();
    @AuraEnabled
    public List<String> automations = new List<String>();
    @AuraEnabled
    public String label;
  }

  /** Automatisations inventoriées par le scan (flows, Process Builder, triggers, règles de validation). */
  public static List<Automation> load(List<OrgScanModels.Component> components) {
    List<Automation> result = new List<Automation>();
    for (OrgScanModels.Component component : components) {
      Map<String, Object> details = component.details == null
        ? new Map<String, Object>()
        : component.details;
      Automation automation = new Automation();
      automation.apiName = component.apiName;
      automation.isActive = component.isActive;
      automation.apiVersion = component.apiVersion;
      automation.description = component.description;
      automation.metadataId = component.metadataId;
      automation.objectName = component.parentName;
      if (component.componentType == 'ApexTrigger') {
        automation.kind = 'Apex trigger';
        automation.label = component.apiName;
        for (
          Object event : details.get('events') instanceof List<Object>
            ? (List<Object>) details.get('events')
            : new List<Object>()
        ) {
          automation.events.add(String.valueOf(event));
        }
        automation.timing = 'Trigger';
      } else if (component.componentType == 'ValidationRule') {
        automation.kind = 'Validation rule';
        automation.label = component.apiName.substringAfter('.');
        automation.timing = 'Validation';
        automation.events = new List<String>{ 'Create', 'Update' };
      } else {
        automation.label = (String) details.get('label');
        automation.versionId = (String) (details.get('analysedVersionId') !=
          null
          ? details.get('analysedVersionId')
          : details.get('activeVersionId'));
        Object model = details.get('model');
        if (model != null) {
          automation.modelJson = JSON.serialize(model);
          automation.model = (OrgFlowAnalyzer.FlowModel) JSON.deserialize(
            automation.modelJson,
            OrgFlowAnalyzer.FlowModel.class
          );
          automation.objectName = automation.model.triggerObject != null
            ? automation.model.triggerObject
            : automation.objectName;
          automation.timing = automation.model.timing;
          automation.events = eventsOf(automation.model.triggerEvent);
        } else {
          automation.timing = details.get('processType') == 'Workflow'
            ? 'Process Builder'
            : (String) details.get('triggerType');
        }
        automation.kind = details.get('processType') == 'Workflow'
          ? 'Process Builder'
          : 'Flow';
      }
      result.add(automation);
    }
    return result;
  }

  public static List<String> eventsOf(String triggerEvent) {
    switch on triggerEvent {
      when 'Create' {
        return new List<String>{ 'Create' };
      }
      when 'Update' {
        return new List<String>{ 'Update' };
      }
      when 'CreateAndUpdate' {
        return new List<String>{ 'Create', 'Update' };
      }
      when 'Delete' {
        return new List<String>{ 'Delete' };
      }
      when else {
        return new List<String>();
      }
    }
  }

  /**
   * Cycles entre objets : arête A → B quand une automatisation active déclenchée sur A écrit B
   * (une mise à jour du même enregistrement en before-save ne redéclenche rien et n'est pas une arête).
   */
  public static List<Cycle> findCycles(List<Automation> automations) {
    Map<String, Map<String, Set<String>>> edges = new Map<String, Map<String, Set<String>>>();
    for (Automation automation : automations) {
      if (
        automation.model == null ||
        automation.isActive != true ||
        automation.objectName == null
      ) {
        continue;
      }
      for (OrgFlowAnalyzer.DataAccess access : automation.model.writes) {
        if (access.objectName == null || access.operation == 'Delete') {
          continue;
        }
        if (access.objectName == automation.objectName) {
          continue; // boucle sur le même objet : couverte par la règle after-save
        }
        if (!edges.containsKey(automation.objectName)) {
          edges.put(automation.objectName, new Map<String, Set<String>>());
        }
        Map<String, Set<String>> targets = edges.get(automation.objectName);
        if (!targets.containsKey(access.objectName)) {
          targets.put(access.objectName, new Set<String>());
        }
        targets.get(access.objectName).add(automation.apiName);
      }
    }
    List<String> nodes = new List<String>(edges.keySet());
    nodes.sort();
    Map<String, Cycle> cycles = new Map<String, Cycle>();
    Set<String> visited = new Set<String>();
    for (String node : nodes) {
      // les objets déjà traités sont exclus : chaque cycle n'est parcouru qu'à partir de son plus petit objet
      walk(
        node,
        node,
        new List<String>{ node },
        edges,
        new Set<String>(visited),
        cycles
      );
      visited.add(node);
    }
    return cycles.values();
  }

  private static void walk(
    String origin,
    String current,
    List<String> path,
    Map<String, Map<String, Set<String>>> edges,
    Set<String> excluded,
    Map<String, Cycle> cycles
  ) {
    if (path.size() > MAX_CYCLE_LENGTH || !edges.containsKey(current)) {
      return;
    }
    for (String next : edges.get(current).keySet()) {
      if (next == origin && path.size() > 1) {
        List<String> sorted = new List<String>(path);
        sorted.sort();
        String key = String.join(sorted, '>');
        if (!cycles.containsKey(key)) {
          Cycle cycle = new Cycle();
          cycle.key = key;
          cycle.objects.addAll(path);
          Set<String> via = new Set<String>();
          for (Integer k = 0; k < path.size(); k++) {
            String fromObject = path[k];
            String toObject = k + 1 < path.size() ? path[k + 1] : origin;
            via.addAll(edges.get(fromObject).get(toObject));
          }
          cycle.automations.addAll(via);
          cycle.automations.sort();
          cycle.label = String.join(path, ' → ') + ' → ' + origin;
          cycles.put(key, cycle);
        }
      } else if (!path.contains(next) && !excluded.contains(next)) {
        List<String> extended = new List<String>(path);
        extended.add(next);
        walk(origin, next, extended, edges, excluded, cycles);
      }
    }
  }
}
