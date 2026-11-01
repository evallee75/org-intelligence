/**
 * Analyse statique simple d'un source Apex (classe ou trigger).
 *
 * Le source est d'abord « nettoyé » : commentaires effacés et contenu des chaînes masqué, longueur
 * et retours à la ligne conservés (les numéros de ligne restent justes). Les règles travaillent sur
 * ce code nettoyé, ce qui évite les faux positifs dans les commentaires et les textes.
 */
public inherited sharing class OrgApexSourceAnalyzer {
  private static final Integer QUOTE = 39; // '
  private static final Integer BACKSLASH = 92;
  private static final Integer SLASH = 47;
  private static final Integer STAR = 42;
  private static final Integer NEWLINE = 10;
  private static final Integer SPACE = 32;

  private static final String CHECKSUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  private static final Pattern ID_SHAPE = Pattern.compile(
    '^[a-zA-Z0-9]{5}000[a-zA-Z0-9]{7}([a-zA-Z0-9]{3})?$'
  );
  private static final Pattern LOOP_HEADER = Pattern.compile(
    '\\b(for|while)\\s*\\('
  );
  private static final Pattern DO_LOOP = Pattern.compile('\\bdo\\s*\\{');
  private static final Pattern SOQL = Pattern.compile('\\[\\s*select\\b');
  private static final Pattern DATABASE_CALL = Pattern.compile(
    '\\bdatabase\\s*\\.\\s*(query|querywithbinds|countquery|insert|update|upsert|delete|undelete|merge)\\s*\\('
  );
  private static final Pattern DML_STATEMENT = Pattern.compile(
    '(^|[;{}\\s])(insert|update|upsert|delete|undelete|merge)\\s+[a-z_(]'
  );
  private static final Pattern ASSERTION = Pattern.compile(
    '\\b(system\\s*\\.\\s*assert\\w*|assert\\s*\\.\\s*\\w+)\\s*\\('
  );
  private static final Pattern AURA_METHOD = Pattern.compile(
    '@auraenabled(\\s*\\([^)]*\\))?\\s+(\\w+\\s+)*static\\s+[^;={]*\\('
  );
  private static final Pattern CLASS_KEYWORD = Pattern.compile(
    '\\b(class|trigger)\\b'
  );

  /** Code sans commentaires, chaînes masquées. */
  public String code { get; private set; }
  /** Code nettoyé en minuscules (Apex est insensible à la casse). */
  public String lowerCode { get; private set; }
  /** Littéraux de chaîne, dans l'ordre d'apparition. */
  public List<Literal> literals { get; private set; }

  public class Literal {
    public String value;
    public Integer line;

    public Literal(String value, Integer line) {
      this.value = value;
      this.line = line;
    }
  }

  /** Requête ou DML repéré dans le corps d'une boucle. */
  public class LoopHit {
    public Integer line;
    public Integer loopLine;
    public String kind;
  }

  public OrgApexSourceAnalyzer(String source) {
    clean(source == null ? '' : source);
    lowerCode = code.toLowerCase();
  }

  private void clean(String source) {
    List<Integer> chars = source.getChars();
    List<Integer> output = new List<Integer>();
    literals = new List<Literal>();
    Integer size = chars.size();
    Integer line = 1;
    Integer i = 0;
    while (i < size) {
      Integer current = chars[i];
      Integer next = i + 1 < size ? chars[i + 1] : -1;
      if (current == SLASH && next == SLASH) {
        // Commentaire de ligne : effacé jusqu'au retour à la ligne
        while (i < size && chars[i] != NEWLINE) {
          output.add(SPACE);
          i++;
        }
      } else if (current == SLASH && next == STAR) {
        output.add(SPACE);
        output.add(SPACE);
        i += 2;
        while (
          i < size &&
          !(chars[i] == STAR &&
          i + 1 < size &&
          chars[i + 1] == SLASH)
        ) {
          if (chars[i] == NEWLINE) {
            line++;
            output.add(NEWLINE);
          } else {
            output.add(SPACE);
          }
          i++;
        }
        if (i < size) {
          output.add(SPACE);
          output.add(SPACE);
          i += 2;
        }
      } else if (current == QUOTE) {
        // Chaîne : contenu remplacé par des « x », valeur conservée à part
        Integer startLine = line;
        List<Integer> value = new List<Integer>();
        output.add(QUOTE);
        i++;
        while (i < size && chars[i] != QUOTE && chars[i] != NEWLINE) {
          if (chars[i] == BACKSLASH && i + 1 < size) {
            value.add(chars[i]);
            value.add(chars[i + 1]);
            output.add(120);
            output.add(120);
            i += 2;
            continue;
          }
          value.add(chars[i]);
          output.add(120);
          i++;
        }
        if (i < size && chars[i] == QUOTE) {
          output.add(QUOTE);
          i++;
        }
        literals.add(new Literal(String.fromCharArray(value), startLine));
      } else {
        if (current == NEWLINE) {
          line++;
        }
        output.add(current);
        i++;
      }
    }
    code = String.fromCharArray(output);
  }

  // ---------- Identifiants codés en dur ----------

  /**
   * Vrai si la valeur a la forme d'un Id Salesforce : 15 ou 18 caractères alphanumériques, suite de
   * zéros après le préfixe et l'instance, et somme de contrôle valide pour 18 caractères.
   */
  public static Boolean looksLikeRecordId(String value) {
    if (
      value == null ||
      (value.length() != 15 &&
      value.length() != 18) ||
      !value.isAlphanumeric() ||
      !ID_SHAPE.matcher(value).matches()
    ) {
      return false;
    }
    if (value.substring(3, 15).containsOnly('0')) {
      return false; // Id factice de test : préfixe suivi de zéros (003000000000000AAA)
    }
    return value.length() == 15 ||
      checksum(value.substring(0, 15)).equals(value.substring(15));
  }

  @TestVisible
  private static String checksum(String id15) {
    String suffix = '';
    for (Integer block = 0; block < 3; block++) {
      Integer flags = 0;
      for (Integer position = 0; position < 5; position++) {
        String character = id15.substring(
          block * 5 + position,
          block * 5 + position + 1
        );
        if (character.isAllUpperCase() && character.isAlpha()) {
          flags += 1 << position;
        }
      }
      suffix += CHECKSUM_CHARS.substring(flags, flags + 1);
    }
    return suffix;
  }

  /** Littéraux ressemblant à des Ids, avec leur ligne (un par valeur). */
  public List<Literal> hardcodedIds() {
    List<Literal> result = new List<Literal>();
    Set<String> seen = new Set<String>();
    for (Literal literal : literals) {
      if (looksLikeRecordId(literal.value) && seen.add(literal.value)) {
        result.add(literal);
      }
    }
    return result;
  }

  // ---------- Requêtes et DML dans les boucles ----------

  public List<LoopHit> queriesOrDmlInLoops() {
    Map<Integer, LoopHit> hitsByPosition = new Map<Integer, LoopHit>();
    List<Integer> chars = lowerCode.getChars();

    Matcher header = LOOP_HEADER.matcher(lowerCode);
    while (header.find()) {
      Integer close = matching(chars, header.end() - 1, 40, 41);
      Integer bodyStart = close < 0 ? -1 : nextNonSpace(chars, close + 1);
      if (bodyStart >= 0 && chars[bodyStart] == 123) {
        scanBody(chars, header.start(), bodyStart, hitsByPosition);
      }
    }
    Matcher doLoop = DO_LOOP.matcher(lowerCode);
    while (doLoop.find()) {
      scanBody(chars, doLoop.start(), doLoop.end() - 1, hitsByPosition);
    }

    List<Integer> positions = new List<Integer>(hitsByPosition.keySet());
    positions.sort();
    List<LoopHit> result = new List<LoopHit>();
    for (Integer position : positions) {
      result.add(hitsByPosition.get(position));
    }
    return result;
  }

  private void scanBody(
    List<Integer> chars,
    Integer loopStart,
    Integer bodyStart,
    Map<Integer, LoopHit> hits
  ) {
    Integer bodyEnd = matching(chars, bodyStart, 123, 125);
    if (bodyEnd < 0) {
      return;
    }
    String body = lowerCode.substring(bodyStart, bodyEnd);
    collect(SOQL.matcher(body), 0, 'SOQL query', bodyStart, loopStart, hits);
    collect(
      DATABASE_CALL.matcher(body),
      0,
      'Database method',
      bodyStart,
      loopStart,
      hits
    );
    collect(
      DML_STATEMENT.matcher(body),
      2,
      'DML statement',
      bodyStart,
      loopStart,
      hits
    );
  }

  private void collect(
    Matcher matcher,
    Integer groupIndex,
    String kind,
    Integer offset,
    Integer loopStart,
    Map<Integer, LoopHit> hits
  ) {
    while (matcher.find()) {
      Integer position = offset + matcher.start(groupIndex);
      if (!hits.containsKey(position)) {
        LoopHit hit = new LoopHit();
        hit.kind = kind;
        hit.line = lineAt(position);
        hit.loopLine = lineAt(loopStart);
        hits.put(position, hit);
      }
    }
  }

  /** Index du caractère fermant correspondant à l'ouvrant situé en `start`, -1 sinon. */
  private static Integer matching(
    List<Integer> chars,
    Integer start,
    Integer open,
    Integer close
  ) {
    Integer depth = 0;
    for (Integer i = start; i < chars.size(); i++) {
      if (chars[i] == open) {
        depth++;
      } else if (chars[i] == close) {
        depth--;
        if (depth == 0) {
          return i;
        }
      }
    }
    return -1;
  }

  private static Integer nextNonSpace(List<Integer> chars, Integer start) {
    for (Integer i = start; i < chars.size(); i++) {
      if (
        chars[i] != SPACE &&
        chars[i] != NEWLINE &&
        chars[i] != 9 &&
        chars[i] != 13
      ) {
        return i;
      }
    }
    return -1;
  }

  public Integer lineAt(Integer position) {
    return code.substring(0, Math.min(position, code.length()))
        .countMatches('\n') + 1;
  }

  // ---------- Structure ----------

  /** Texte qui précède le mot-clé class/trigger : annotations et modificateurs de la déclaration. */
  public String declarationPrefix() {
    Matcher matcher = CLASS_KEYWORD.matcher(lowerCode);
    return matcher.find() ? lowerCode.substring(0, matcher.start()) : '';
  }

  /** 'with', 'without', 'inherited' ou null (aucune déclaration de partage sur la classe). */
  public String sharingDeclaration() {
    String prefix = declarationPrefix().normalizeSpace();
    for (String keyword : new List<String>{ 'without', 'inherited', 'with' }) {
      if (prefix.contains(keyword + ' sharing')) {
        return keyword;
      }
    }
    return null;
  }

  public Boolean isTestClass() {
    return declarationPrefix().contains('@istest');
  }

  public Boolean hasTestMethods() {
    Integer annotations = lowerCode.countMatches('@istest');
    Integer classAnnotation = isTestClass() ? 1 : 0;
    return annotations > classAnnotation || lowerCode.contains('testmethod');
  }

  public Boolean hasAssertions() {
    return ASSERTION.matcher(lowerCode).find();
  }

  /**
   * Marqueurs d'exposition à l'interface ou à des systèmes externes. @AuraEnabled ne compte que sur
   * une méthode (static) : sur une propriété de DTO, il n'expose pas la classe.
   */
  public List<String> entryPointMarkers() {
    List<String> markers = new List<String>();
    if (AURA_METHOD.matcher(lowerCode).find()) {
      markers.add('@AuraEnabled');
    }
    if (lowerCode.contains('@restresource')) {
      markers.add('@RestResource');
    }
    if (Pattern.compile('\\bwebservice\\s').matcher(lowerCode).find()) {
      markers.add('webservice');
    }
    return markers;
  }

  /** Lignes de code (hors lignes vides et commentaires). */
  public Integer codeLineCount() {
    Integer count = 0;
    for (String line : code.split('\n')) {
      if (String.isNotBlank(line)) {
        count++;
      }
    }
    return count;
  }
}
