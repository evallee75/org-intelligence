/**
 * Analyse d'une définition de flow (Tooling API, champ Metadata désérialisé) : modèle compact pour
 * la vue Automation et constats sur la logique du flow.
 *
 * Le modèle décrit ce que fait le flow sans en recopier la définition : déclenchement (objet,
 * moment, événement, critères), entrées/sorties, objets lus et écrits, sous-flows et actions, et
 * les éléments problématiques (requêtes ou DML dans une boucle, absence de chemin d'erreur).
 */
public inherited sharing class OrgFlowAnalyzer {
  private static final List<String> ELEMENT_TYPES = new List<String>{
    'actionCalls',
    'assignments',
    'collectionProcessors',
    'customErrors',
    'decisions',
    'loops',
    'recordCreates',
    'recordDeletes',
    'recordLookups',
    'recordRollbacks',
    'recordUpdates',
    'screens',
    'subflows',
    'transforms',
    'waits'
  };
  private static final Set<String> DATA_TYPES = new Set<String>{
    'recordCreates',
    'recordDeletes',
    'recordLookups',
    'recordUpdates'
  };
  private static final Set<String> LOOP_COSTLY_TYPES = new Set<String>{
    'recordCreates',
    'recordDeletes',
    'recordLookups',
    'recordUpdates',
    'subflows',
    'actionCalls'
  };
  private static final Set<String> SAME_RECORD_REFERENCES = new Set<String>{
    '$record',
    '$record.id',
    'myvariable_current',
    'myvariable_current.id'
  };
  private static final Pattern STRING_VALUE = Pattern.compile(
    '"stringValue"\\s*:\\s*"([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})"'
  );

  /** Modèle d'un flow, renvoyé au navigateur dans les détails du composant (clé « model »). */
  public class FlowModel {
    public String label;
    public String processType;
    public String triggerObject;
    public String timing;
    public String triggerEvent;
    public Boolean isRecordTriggered = false;
    public Integer triggerOrder;
    public String runInMode;
    public String entryCriteria;
    public Boolean hasEntryCriteria = false;
    public Integer scheduledPaths = 0;
    public List<VariableInfo> inputs = new List<VariableInfo>();
    public List<VariableInfo> outputs = new List<VariableInfo>();
    public List<DataAccess> writes = new List<DataAccess>();
    public List<String> reads = new List<String>();
    public List<String> subflows = new List<String>();
    public List<String> apexActions = new List<String>();
    public List<String> otherActions = new List<String>();
    public Map<String, Integer> elementCounts = new Map<String, Integer>();
    public Integer elementCount = 0;
    public List<String> costlyInLoop = new List<String>();
    public List<String> missingFaultPaths = new List<String>();
    public List<String> hardcodedIds = new List<String>();
    /** Logigramme : éléments et connecteurs (Start → … ), pour le diagramme du flow. */
    public List<DiagramNode> nodes = new List<DiagramNode>();
    public List<DiagramEdge> edges = new List<DiagramEdge>();
  }

  public class DiagramNode {
    public String id;
    public String label;
    public String type;
  }

  public class DiagramEdge {
    public String source;
    public String target;
    public String label;
    public Boolean fault = false;
  }

  public class VariableInfo {
    public String name;
    public String dataType;
    public Boolean isCollection;

    public VariableInfo() {
    }

    public VariableInfo(String name, String dataType, Boolean isCollection) {
      this.name = name;
      this.dataType = dataType;
      this.isCollection = isCollection;
    }
  }

  public class DataAccess {
    public String objectName;
    public String operation;
    public String element;
    public Boolean sameRecord = false;
    /** Champs écrits (affectations de l'élément ou de la variable enregistrée). */
    public List<String> fields = new List<String>();
  }

  private Map<String, Object> metadata;
  private Map<String, Map<String, Object>> elements = new Map<String, Map<String, Object>>();
  private Map<String, String> elementTypes = new Map<String, String>();
  public FlowModel model = new FlowModel();

  public OrgFlowAnalyzer(Map<String, Object> metadata, String definitionJson) {
    this.metadata = metadata == null ? new Map<String, Object>() : metadata;
    indexElements();
    readTrigger();
    readVariables();
    readDataAndActions();
    findCostlyElementsInLoops();
    findMissingFaultPaths();
    findHardcodedIds(definitionJson);
    buildDiagram();
  }

  private static final Integer MAX_DIAGRAM_NODES = 120;

  private void buildDiagram() {
    DiagramNode start = new DiagramNode();
    start.id = 'START';
    start.type = 'start';
    start.label = model.isRecordTriggered && model.triggerObject != null
      ? model.triggerObject + (model.timing == null ? '' : ' · ' + model.timing)
      : 'Start';
    model.nodes.add(start);

    Map<String, Object> startElement = (Map<String, Object>) metadata.get(
      'start'
    );
    if (startElement != null) {
      addEdge('START', target(startElement.get('connector')), null, false);
      for (
        Map<String, Object> path : listOf(startElement.get('scheduledPaths'))
      ) {
        addEdge(
          'START',
          target(path.get('connector')),
          (String) path.get('label'),
          false
        );
      }
    } else {
      addEdge(
        'START',
        (String) metadata.get('startElementReference'),
        null,
        false
      );
    }

    for (String name : elements.keySet()) {
      if (model.nodes.size() >= MAX_DIAGRAM_NODES) {
        break;
      }
      Map<String, Object> element = elements.get(name);
      String type = elementTypes.get(name);
      DiagramNode node = new DiagramNode();
      node.id = name;
      node.type = type;
      node.label = element.get('label') != null
        ? (String) element.get('label')
        : name;
      model.nodes.add(node);

      addEdge(name, target(element.get('connector')), null, false);
      addEdge(name, target(element.get('faultConnector')), 'Fault', true);
      for (Map<String, Object> rule : listOf(element.get('rules'))) {
        addEdge(
          name,
          target(rule.get('connector')),
          (String) rule.get('label'),
          false
        );
      }
      if (element.get('defaultConnector') != null) {
        String label = (String) element.get('defaultConnectorLabel');
        addEdge(
          name,
          target(element.get('defaultConnector')),
          label == null ? 'Default' : label,
          false
        );
      }
      if (type == 'loops') {
        addEdge(
          name,
          target(element.get('nextValueConnector')),
          'For each',
          false
        );
        addEdge(
          name,
          target(element.get('noMoreValuesConnector')),
          'After last',
          false
        );
      }
      for (Map<String, Object> waitEvent : listOf(element.get('waitEvents'))) {
        addEdge(
          name,
          target(waitEvent.get('connector')),
          (String) waitEvent.get('label'),
          false
        );
      }
    }
  }

  private void addEdge(
    String source,
    String targetName,
    String label,
    Boolean fault
  ) {
    if (targetName == null) {
      return;
    }
    DiagramEdge edge = new DiagramEdge();
    edge.source = source;
    edge.target = targetName;
    edge.label = label?.abbreviate(30);
    edge.fault = fault;
    model.edges.add(edge);
  }

  // ---------- Déclenchement ----------

  private void readTrigger() {
    model.label = (String) metadata.get('label');
    model.processType = (String) metadata.get('processType');
    model.runInMode = (String) metadata.get('runInMode');
    Object order = metadata.get('triggerOrder');
    model.triggerOrder = order == null ? null : Integer.valueOf(order);

    if (model.processType == 'Workflow') {
      // Process Builder : objet et événement dans processMetadataValues, critères dans les décisions
      model.triggerObject = processValue(metadata, 'ObjectType');
      String triggerType = processValue(metadata, 'TriggerType');
      model.timing = 'Process Builder';
      model.triggerEvent = triggerType == 'onCreateOnly'
        ? 'Create'
        : 'CreateAndUpdate';
      model.isRecordTriggered = model.triggerObject != null;
      List<String> criteria = new List<String>();
      for (Map<String, Object> decision : listOf(metadata.get('decisions'))) {
        for (Map<String, Object> rule : listOf(decision.get('rules'))) {
          criteria.add((String) rule.get('label'));
        }
      }
      for (Map<String, Object> formula : listOf(metadata.get('formulas'))) {
        String expression = (String) formula.get('expression');
        if (String.isNotBlank(expression)) {
          criteria.add(expression.normalizeSpace().abbreviate(300));
        }
      }
      model.hasEntryCriteria = !criteria.isEmpty();
      model.entryCriteria = criteria.isEmpty()
        ? null
        : String.join(criteria, ' | ').abbreviate(1000);
      return;
    }

    Map<String, Object> start = (Map<String, Object>) metadata.get('start');
    if (start == null) {
      model.timing = model.processType == 'Flow' ? 'Screen flow' : 'Invoked';
      return;
    }
    model.triggerObject = (String) start.get('object');
    String triggerType = (String) start.get('triggerType');
    model.triggerEvent = (String) start.get('recordTriggerType');
    model.scheduledPaths = listOf(start.get('scheduledPaths')).size();
    switch on triggerType {
      when 'RecordBeforeSave' {
        model.timing = 'Before save';
      }
      when 'RecordAfterSave' {
        model.timing = 'After save';
      }
      when 'RecordBeforeDelete' {
        model.timing = 'Before delete';
        model.triggerEvent = 'Delete';
      }
      when 'Scheduled' {
        model.timing = 'Scheduled';
      }
      when 'PlatformEvent' {
        model.timing = 'Platform event';
      }
      when else {
        model.timing = model.processType == 'Flow' ? 'Screen flow' : 'Invoked';
      }
    }
    model.isRecordTriggered =
      triggerType != null && triggerType.startsWith('Record');

    List<String> conditions = new List<String>();
    for (Map<String, Object> filter : listOf(start.get('filters'))) {
      conditions.add(
        filter.get('field') +
          ' ' +
          filter.get('operator') +
          ' ' +
          valueText(filter.get('value'))
      );
    }
    String formula = (String) start.get('filterFormula');
    if (String.isNotBlank(formula)) {
      conditions.add(formula.normalizeSpace());
    }
    String logic = (String) start.get('filterLogic');
    model.hasEntryCriteria = !conditions.isEmpty();
    model.entryCriteria = conditions.isEmpty()
      ? null
      : String.join(conditions, logic == 'or' ? ' OR ' : ' AND ')
          .abbreviate(1000);
  }

  // ---------- Variables ----------

  private void readVariables() {
    for (Map<String, Object> variable : listOf(metadata.get('variables'))) {
      String name = (String) variable.get('name');
      if (name != null && name.startsWith('myVariable_')) {
        continue; // variables techniques des Process Builder
      }
      String type = (String) variable.get('dataType');
      if (variable.get('objectType') != null) {
        type += ' (' + variable.get('objectType') + ')';
      }
      VariableInfo info = new VariableInfo(
        name,
        type,
        variable.get('isCollection') == true
      );
      if (variable.get('isInput') == true) {
        model.inputs.add(info);
      }
      if (variable.get('isOutput') == true) {
        model.outputs.add(info);
      }
    }
  }

  // ---------- Données et actions ----------

  private void readDataAndActions() {
    Set<String> reads = new Set<String>();
    for (String type : ELEMENT_TYPES) {
      Integer count = listOf(metadata.get(type)).size();
      if (count > 0) {
        model.elementCounts.put(type, count);
        model.elementCount += count;
      }
    }
    for (Map<String, Object> lookup : listOf(metadata.get('recordLookups'))) {
      String objectName = (String) lookup.get('object');
      if (objectName != null) {
        reads.add(objectName);
      }
    }
    model.reads = new List<String>(reads);
    addWrites('recordUpdates', 'Update');
    addWrites('recordCreates', 'Create');
    addWrites('recordDeletes', 'Delete');
    addBeforeSaveAssignments();
    for (Map<String, Object> subflow : listOf(metadata.get('subflows'))) {
      model.subflows.add((String) subflow.get('flowName'));
    }
    for (Map<String, Object> action : listOf(metadata.get('actionCalls'))) {
      String type = (String) action.get('actionType');
      String name = (String) action.get('actionName');
      if (type == 'apex') {
        model.apexActions.add(name);
      } else {
        model.otherActions.add(type + ': ' + name);
      }
    }
  }

  private void addWrites(String type, String operation) {
    for (Map<String, Object> element : listOf(metadata.get(type))) {
      DataAccess access = new DataAccess();
      access.operation = operation;
      access.element = (String) element.get('label') != null
        ? (String) element.get('label')
        : (String) element.get('name');
      String reference = ((String) element.get('inputReference'))
        ?.toLowerCase();
      access.objectName = (String) element.get('object');
      access.sameRecord =
        reference != null && SAME_RECORD_REFERENCES.contains(reference);
      for (Map<String, Object> filter : listOf(element.get('filters'))) {
        Map<String, Object> value = (Map<String, Object>) filter.get('value');
        String referenceValue = value == null
          ? null
          : ((String) value.get('elementReference'))?.toLowerCase();
        if (
          filter.get('field') == 'Id' &&
          referenceValue != null &&
          SAME_RECORD_REFERENCES.contains(referenceValue)
        ) {
          access.sameRecord = true;
        }
      }
      if (
        access.objectName == null &&
        reference != null &&
        referenceObjects().containsKey(reference.substringBefore('.'))
      ) {
        access.objectName = referenceObjects()
          .get(reference.substringBefore('.'));
      }
      access.fields = writtenFields(element, reference);
      if (access.objectName == null && access.sameRecord) {
        access.objectName = model.triggerObject;
      }
      if (
        access.sameRecord &&
        operation == 'Update' &&
        access.objectName == null
      ) {
        access.objectName = model.triggerObject;
      }
      model.writes.add(access);
    }
  }

  /**
   * Champs écrits par un élément de données : ses affectations directes, sinon les affectations
   * faites dans le flow sur la variable qu'il enregistre (« var.Champ »).
   */
  private List<String> writtenFields(
    Map<String, Object> element,
    String reference
  ) {
    Set<String> fields = new Set<String>();
    for (Map<String, Object> item : listOf(element.get('inputAssignments'))) {
      if (item.get('field') != null) {
        fields.add((String) item.get('field'));
      }
    }
    if (fields.isEmpty() && reference != null) {
      fields.addAll(assignedFields(reference.substringBefore('.')));
    }
    List<String> sorted = new List<String>(fields);
    sorted.sort();
    return sorted;
  }

  /** Champs affectés par des éléments Assignment sur une variable (« variable.Champ »). */
  private Set<String> assignedFields(String variable) {
    Set<String> fields = new Set<String>();
    String prefix = variable.toLowerCase() + '.';
    for (Map<String, Object> assignment : listOf(metadata.get('assignments'))) {
      for (
        Map<String, Object> item : listOf(assignment.get('assignmentItems'))
      ) {
        String target = (String) item.get('assignToReference');
        if (
          target != null &&
          target.toLowerCase().startsWith(prefix) &&
          !target.substringAfter('.').contains('.')
        ) {
          fields.add(target.substringAfter('.'));
        }
      }
    }
    return fields;
  }

  /** Flow before-save : les affectations sur $Record sont des écritures sur l'enregistrement déclencheur. */
  private void addBeforeSaveAssignments() {
    if (model.timing != 'Before save') {
      return;
    }
    List<String> fields = new List<String>(assignedFields('$Record'));
    if (fields.isEmpty()) {
      return;
    }
    fields.sort();
    DataAccess access = new DataAccess();
    access.operation = 'Update';
    access.element = 'Assignments to $Record';
    access.objectName = model.triggerObject;
    access.sameRecord = true;
    access.fields = fields;
    model.writes.add(access);
  }

  private Map<String, String> referenceObjectsCache;

  /** Objet de chaque variable ou requête nommée (pour les écritures faites « depuis une variable »). */
  private Map<String, String> referenceObjects() {
    if (referenceObjectsCache != null) {
      return referenceObjectsCache;
    }
    referenceObjectsCache = new Map<String, String>();
    for (Map<String, Object> variable : listOf(metadata.get('variables'))) {
      if (variable.get('objectType') != null && variable.get('name') != null) {
        referenceObjectsCache.put(
          ((String) variable.get('name')).toLowerCase(),
          (String) variable.get('objectType')
        );
      }
    }
    for (Map<String, Object> lookup : listOf(metadata.get('recordLookups'))) {
      if (lookup.get('object') != null && lookup.get('name') != null) {
        referenceObjectsCache.put(
          ((String) lookup.get('name')).toLowerCase(),
          (String) lookup.get('object')
        );
      }
    }
    for (Map<String, Object> loopItem : listOf(metadata.get('loops'))) {
      String collection = ((String) loopItem.get('collectionReference'))
        ?.toLowerCase();
      if (
        collection != null &&
        referenceObjectsCache.containsKey(collection) &&
        loopItem.get('name') != null
      ) {
        referenceObjectsCache.put(
          ((String) loopItem.get('name')).toLowerCase(),
          referenceObjectsCache.get(collection)
        );
      }
    }
    if (model.triggerObject != null) {
      referenceObjectsCache.put('$record', model.triggerObject);
      referenceObjectsCache.put('$record__prior', model.triggerObject);
    }
    return referenceObjectsCache;
  }

  // ---------- Boucles ----------

  private void indexElements() {
    for (String type : ELEMENT_TYPES) {
      for (Map<String, Object> element : listOf(metadata.get(type))) {
        String name = (String) element.get('name');
        if (name != null) {
          elements.put(name, element);
          elementTypes.put(name, type);
        }
      }
    }
  }

  /** Éléments atteints depuis le corps d'une boucle avant d'y revenir. */
  private void findCostlyElementsInLoops() {
    Set<String> flagged = new Set<String>();
    for (Map<String, Object> loopElement : listOf(metadata.get('loops'))) {
      String loopName = (String) loopElement.get('name');
      List<String> queue = new List<String>{
        target(loopElement.get('nextValueConnector'))
      };
      Set<String> seen = new Set<String>{ loopName };
      while (!queue.isEmpty()) {
        String current = queue.remove(0);
        if (
          current == null ||
          seen.contains(current) ||
          !elements.containsKey(current)
        ) {
          continue;
        }
        seen.add(current);
        String type = elementTypes.get(current);
        if (LOOP_COSTLY_TYPES.contains(type) && flagged.add(current)) {
          Map<String, Object> element = elements.get(current);
          String label = element.get('label') != null
            ? (String) element.get('label')
            : current;
          model.costlyInLoop.add(
            label +
              ' (' +
              describeType(type) +
              ') in loop "' +
              (loopElement.get('label') != null
                ? loopElement.get('label')
                : loopName) +
              '"'
          );
        }
        queue.addAll(nextElements(elements.get(current), type));
      }
    }
  }

  private List<String> nextElements(Map<String, Object> element, String type) {
    List<String> result = new List<String>();
    result.add(target(element.get('connector')));
    result.add(target(element.get('faultConnector')));
    result.add(target(element.get('defaultConnector')));
    for (Map<String, Object> rule : listOf(element.get('rules'))) {
      result.add(target(rule.get('connector')));
    }
    if (type == 'loops') {
      // boucle imbriquée : son corps fait partie du corps courant
      result.add(target(element.get('nextValueConnector')));
      result.add(target(element.get('noMoreValuesConnector')));
    }
    for (Map<String, Object> waitEvent : listOf(element.get('waitEvents'))) {
      result.add(target(waitEvent.get('connector')));
    }
    return result;
  }

  // ---------- Chemins d'erreur ----------

  private void findMissingFaultPaths() {
    for (String name : elements.keySet()) {
      String type = elementTypes.get(name);
      if (!DATA_TYPES.contains(type) && type != 'actionCalls') {
        continue;
      }
      if (type == 'recordLookups') {
        continue; // une requête en échec est rare ; on cible les écritures et actions
      }
      Map<String, Object> element = elements.get(name);
      if (element.get('faultConnector') == null) {
        model.missingFaultPaths.add(
          element.get('label') != null ? (String) element.get('label') : name
        );
      }
    }
    model.missingFaultPaths.sort();
  }

  // ---------- Identifiants codés en dur ----------

  private void findHardcodedIds(String definitionJson) {
    if (String.isBlank(definitionJson)) {
      return;
    }
    Set<String> found = new Set<String>();
    Matcher matcher = STRING_VALUE.matcher(definitionJson);
    while (matcher.find()) {
      String value = matcher.group(1);
      if (OrgApexSourceAnalyzer.looksLikeRecordId(value)) {
        found.add(value);
      }
    }
    model.hardcodedIds = new List<String>(found);
  }

  // ---------- Utilitaires ----------

  private static String target(Object connector) {
    return connector instanceof Map<String, Object>
      ? (String) ((Map<String, Object>) connector).get('targetReference')
      : null;
  }

  private static List<Map<String, Object>> listOf(Object value) {
    List<Map<String, Object>> result = new List<Map<String, Object>>();
    if (value instanceof List<Object>) {
      for (Object item : (List<Object>) value) {
        if (item instanceof Map<String, Object>) {
          result.add((Map<String, Object>) item);
        }
      }
    }
    return result;
  }

  private static String processValue(Map<String, Object> source, String name) {
    for (
      Map<String, Object> entry : listOf(source.get('processMetadataValues'))
    ) {
      if (entry.get('name') == name) {
        Map<String, Object> value = (Map<String, Object>) entry.get('value');
        return value == null ? null : (String) value.get('stringValue');
      }
    }
    return null;
  }

  private static String valueText(Object raw) {
    if (!(raw instanceof Map<String, Object>)) {
      return '';
    }
    Map<String, Object> value = (Map<String, Object>) raw;
    for (
      String key : new List<String>{
        'stringValue',
        'elementReference',
        'booleanValue',
        'numberValue',
        'dateValue',
        'dateTimeValue'
      }
    ) {
      if (value.get(key) != null) {
        return String.valueOf(value.get(key));
      }
    }
    return '';
  }

  private static String describeType(String type) {
    switch on type {
      when 'recordLookups' {
        return 'Get Records';
      }
      when 'recordCreates' {
        return 'Create Records';
      }
      when 'recordUpdates' {
        return 'Update Records';
      }
      when 'recordDeletes' {
        return 'Delete Records';
      }
      when 'subflows' {
        return 'Subflow';
      }
      when else {
        return 'Action';
      }
    }
  }
}
