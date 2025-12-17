/**
 * Detects if an email is a Gmail forwarding verification email.
 * Uses strict criteria to avoid false positives.
 */
export function isForwardingVerificationEmail(
  sender: string | null,
  bodyText: string | null,
  bodyHtml: string | null
): boolean {
  if (!sender) return false;
  
  const senderLower = sender.toLowerCase();
  
  // Primary: Check if sender is forwarding-noreply@google.com or forwarding-noreply@googlemail.com
  if (senderLower.includes('forwarding-noreply@google.com') || 
      senderLower.includes('forwarding-noreply@googlemail.com')) {
    return true;
  }
  
  // Secondary: Check if body contains the verification link pattern
  // Use original content (not lowercased) to preserve URL integrity
  const bodyContent = bodyHtml || bodyText || '';
  // Gmail uses both mail-settings.google.com and mail.google.com for verification links
  if (bodyContent.includes('https://mail-settings.google.com/mail/vf-') ||
      bodyContent.includes('https://mail.google.com/mail/vf-')) {
    return true;
  }
  
  return false;
}

/**
 * Extracts the Gmail verification link from email body.
 * Only extracts vf- links (verification), explicitly ignores uf- links (unverify).
 * Does not lower-case the body to preserve URL integrity.
 */
export function extractGmailVerificationLink(
  bodyText: string | null,
  bodyHtml: string | null
): string | null {
  // Use original content (not lowercased) to preserve URL integrity
  const bodyContent = bodyHtml || bodyText || '';
  
  // Match only vf- links (verification), not uf- links (unverify)
  // Gmail uses both mail-settings.google.com and mail.google.com for verification links
  // Pattern: https://(mail-settings|mail).google.com/mail/vf-[TOKEN]-[MORE_TOKEN]
  const verificationLinkPattern = /https:\/\/(?:mail-settings|mail)\.google\.com\/mail\/vf-[^\s<>"']+/;
  
  const match = bodyContent.match(verificationLinkPattern);
  if (match && match[0]) {
    return match[0];
  }
  
  return null;
}
