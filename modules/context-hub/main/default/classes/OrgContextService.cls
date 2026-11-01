/**
 * Context Hub : finalise le contexte préparé dans le navigateur pour une IA externe (Claude, ChatGPT…).
 *
 * Édition sans objet : le navigateur rassemble les données (recommandation locale ou du module
 * collaboratif, dernier scan) et produit le Markdown ; Apex ne fait que masquer les secrets connus
 * (OrgApiLogger.redact, même masquage que le journal API) et calculer la taille et l'empreinte
 * SHA-256. Rien n'est stocké ni envoyé : l'utilisateur copie ou télécharge lui-même le résultat.
 */
public inherited sharing class OrgContextService {
  /** Taille maximale acceptée (un aller-retour Aura supporte quelques Mo). */
  public static final Integer MAX_LENGTH = 1000000;

  public class ContextResult {
    public String content;
    public Integer characterCount;
    public String contentHash;
    public Integer redactionCount;
  }

  public static ContextResult prepare(String raw) {
    String source = raw == null ? '' : raw;
    if (source.length() > MAX_LENGTH) {
      throw new IllegalArgumentException(
        'The context is too large (' +
          source.length() +
          ' characters, maximum ' +
          MAX_LENGTH +
          '). Remove some sections.'
      );
    }
    String content = String.isBlank(source)
      ? source
      : OrgApiLogger.redact(source);
    ContextResult result = new ContextResult();
    result.content = content;
    result.characterCount = content.length();
    result.contentHash = EncodingUtil.convertToHex(
      Crypto.generateDigest('SHA-256', Blob.valueOf(content))
    );
    result.redactionCount = Math.max(
      0,
      content.countMatches('•••') - source.countMatches('•••')
    );
    return result;
  }
}
