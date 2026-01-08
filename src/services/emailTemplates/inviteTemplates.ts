type BuildInviteEmailParams = {
  toEmail: string;
  organisationId: string;
  token: string;
  inviterUserId?: string;
  frontendUrl: string;
  organisationName?: string;
  inviterName?: string;
  locationNames?: string[];
  role?: string;
};

/**
 * Get initials from a name (e.g., "James Smith" -> "JS")
 */
function getInitials(name: string): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format role for display (capitalize first letter)
 */
function formatRole(role: string): string {
  if (!role) return 'Member';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

export const buildInviteEmail = (params: BuildInviteEmailParams) => {
  const {
    toEmail,
    organisationName,
    organisationId,
    token,
    inviterName,
    frontendUrl,
    role,
  } = params;

  let safeBase =
    (frontendUrl || '')
      .replace(/app\.thenxt\.ai/gi, 'dashboard.thenxt.ai')
      .replace(/\/$/, '');

  if (process.env.NODE_ENV !== 'production') {
    safeBase = 'http://localhost:3000';
  }

  if (!safeBase) {
    safeBase = process.env.NODE_ENV === 'production' ? 'https://dashboard.thenxt.ai' : 'http://localhost:3000';
  }

  const inviteLink = `${safeBase}/invite/${token}`;
  const orgLabel = organisationName || `Organisation ${organisationId}`;
  const inviterLabel = inviterName || 'A team member';
  const inviterInitials = getInitials(inviterLabel);
  const roleLabel = formatRole(role || 'member');

  const subject = `You're invited to join ${orgLabel} on nxt`;

  // Pre-header text for inbox preview (shows in inbox snippet)
  const preheaderText = `You’ve been invited to join ${orgLabel} on the nxt!`;

  const text = [
    `Join the team!`,
    '',
    `${inviterLabel} invited you to join ${orgLabel} as ${roleLabel === 'Admin' ? 'an' : 'a'} ${roleLabel}.`,
    '',
    `Accept your invite: ${inviteLink}`,
    '',
    `Link expires in 48 hours.`,
    '',
    `If you did not expect this, you can ignore this email.`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>You're Invited to nxt</title>
    <style>
        /* Reset & Base Styles */
        body { margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
        table { border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; width: 100%; }
        
        /* Mobile Responsive */
        @media only screen and (max-width: 500px) {
            .wrapper { width: 100% !important; padding: 0 !important; }
            .content { padding: 32px 24px !important; }
            .action-button { padding: 16px 0 !important; font-size: 16px !important; }
        }
    </style>
</head>
<body style="background-color: #f3f4f6;">

    <!-- PRE-HEADER TEXT (Invisible, but seen in Inbox Preview) -->
    <div style="display:none; font-size:1px; color:#333333; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
        ${preheaderText}
    </div>

    <!-- Main Container -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td align="center" style="padding: 40px 0;">
                
                <!-- Email Wrapper -->
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="480" class="wrapper" style="background-color: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,0.04); max-width: 480px;">
                    
                    <!-- BRAND HEADER -->
                    <tr>
                        <td align="center" style="background-color: #0f172a; padding: 32px 0;">
                            <!-- HTML LOGO -->
                            <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="width: auto;">
                                <tr>
                                    <td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 24px; line-height: 1; color: #ffffff; font-weight: 300; letter-spacing: -0.5px; padding-right: 4px;">the</td>
                                    <td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 24px; line-height: 1; color: #ffffff; font-weight: 800; letter-spacing: -1px; padding-right: 12px;">nxt</td>
                                    <td style="vertical-align: bottom; padding-bottom: 2px;">
                                        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                                            <tr>
                                                <td style="padding: 0 2px; vertical-align: bottom;"><div style="width: 6px; height: 6px; background-color: #ffffff; border-radius: 1px;"></div></td>
                                                <td style="padding: 0 2px; vertical-align: bottom;"><div style="width: 6px; height: 6px; background-color: #ffffff; border-radius: 1px;"></div></td>
                                                <td style="padding: 0 2px; padding-bottom: 6px; vertical-align: bottom;"><div style="width: 6px; height: 6px; background-color: #6366f1; border-radius: 1px; box-shadow: 0 0 10px rgba(99,102,241,0.8);"></div></td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- CONTENT SECTION -->
                    <tr>
                        <td class="content" style="padding: 48px 48px 32px 48px; text-align: center;">
                            
                            <!-- Greeting -->
                            <h1 style="margin: 0 0 24px 0; color: #0f172a; font-size: 24px; font-weight: 700; letter-spacing: -0.8px; line-height: 1.2;">
                                Join the team!
                            </h1>
                            
                            <!-- Inviter Context with Avatar -->
                            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                                <tr>
                                    <td align="center" style="text-align: center;">
                                        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display: inline-table; width: auto; margin: 0 auto;">
                                            <tr>
                                                <!-- Avatar Circle -->
                                                <td style="padding-right: 8px; vertical-align: middle;">
                                                    <div style="width: 32px; height: 32px; background-color: #e0e7ff; border-radius: 50%; text-align: center; line-height: 32px; color: #4338ca; font-size: 12px; font-weight: 700; display: block;">${inviterInitials}</div>
                                                </td>
                                                <!-- Text -->
                                                <td style="color: #64748b; font-size: 16px; line-height: 1.6; vertical-align: middle; text-align: left;">
                                                    <strong style="color: #0f172a;">${inviterLabel}</strong> invited you.
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Value Prop -->
                            <p style="margin: 0 0 12px 0; color: #475569; font-size: 15px; font-weight: 500; line-height: 1.5; letter-spacing: -0.2px;">
                                Catch COGS price increases the moment they happen.
                            </p>
                            
                            <!-- Purple Accent Line -->
                            <div style="width: 60px; height: 3px; background-color: #6366f1; margin: 0 auto 40px auto; border-radius: 2px;"></div>

                            <!-- DETAILS CARD -->
                            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0;">
                                <tr>
                                    <td style="padding: 24px;">
                                        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr>
                                                <td align="left">
                                                    <p style="margin: 0; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Role</p>
                                                    <p style="margin: 4px 0 0 0; color: #0f172a; font-size: 15px; font-weight: 600;">${roleLabel}</p>
                                                </td>
                                                <td align="right">
                                                    <p style="margin: 0; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Workspace</p>
                                                    <p style="margin: 4px 0 0 0; color: #0f172a; font-size: 15px; font-weight: 600;">${orgLabel}</p>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>

                    <!-- ACTION -->
                    <tr>
                        <td align="center" style="padding: 0 48px 48px 48px;">
                            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td align="center">
                                        <a href="${inviteLink}" target="_blank" class="action-button" style="display: block; width: 100%; background-color: #0f172a; color: #ffffff; text-decoration: none; padding: 18px 0; border-radius: 12px; font-size: 16px; font-weight: 600; text-align: center; letter-spacing: -0.3px;">
                                            Accept Invitation
                                        </a>
                                    </td>
                                </tr>
                            </table>
                            
                            <p style="margin: 24px 0 0 0; color: #94a3b8; font-size: 13px; text-align: center;">
                                Link expires in 48 hours.
                            </p>
                        </td>
                    </tr>

                    <!-- FOOTER -->
                    <tr>
                        <td style="background-color: #f8fafc; padding: 32px 48px; border-top: 1px solid #f1f5f9; text-align: center;">
                            <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.6;">
                                Sent by <strong>nxt</strong><br>
                                Automated Supplier Intelligence
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>

</body>
</html>`;

  return {
    to: toEmail,
    subject,
    text,
    html,
  };
};
