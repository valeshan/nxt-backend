import { FeedbackRequestType } from '../../dtos/feedbackDtos';

const escapeHtml = (text: string): string => {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
};

const formatDate = (dateString: string) => {
  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return dateString;
  }
};

type UserInfo = {
  userName: string;
  userEmail: string;
  organisationName: string | null;
  locationName: string | null;
};

export const buildFeedbackEmail = (
  feedback: FeedbackRequestType,
  authUserId: string,
  authUserEmail: string,
  feedbackId: string,
  userInfo: UserInfo
) => {
  const subject = `Feedback submitted - ${feedback.referenceType}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback Submitted</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f2f2f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f2f2f5; padding: 40px 0;">
    <tr>
      <td align="center">
        
        <table width="600" border="0" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.06); max-width: 600px; width: 100%;">
          
          <tr>
            <td style="height: 6px; background: linear-gradient(90deg, #FF4B1F 0%, #FF9068 100%);"></td>
          </tr>

          <tr>
            <td style="padding: 40px 40px 10px 40px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-weight: 800; font-size: 18px; letter-spacing: -1px; color: #000;">the nxt</span>
                  </td>
                  <td style="text-align: right;">
                    <span style="font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #999; letter-spacing: 0.5px;">${formatDate(feedback.timestamp)}</span>
                  </td>
                </tr>
              </table>

              <div style="margin-top: 20px;">
                <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #111; letter-spacing: -0.5px; line-height: 1.2;">
                  Feedback <span style="color: #FF4B1F;">Submitted</span>
                </h1>
                <p style="margin: 10px 0 0; color: #666; font-size: 16px; line-height: 1.5;">
                  Reference Type: <strong>${escapeHtml(feedback.referenceType)}</strong>
                </p>
                <p style="margin: 8px 0 0; color: #999; font-size: 12px; font-family: 'Menlo', 'Consolas', monospace;">
                  Feedback ID: ${escapeHtml(feedbackId)}
                </p>
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 40px 40px 40px;">
              
              <div style="height: 1px; background-color: #eee; margin-bottom: 20px;"></div>

              <div style="margin-bottom: 30px;">
                <p style="font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">
                  MESSAGE
                </p>
                <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; border-left: 4px solid #FF4B1F;">
                  <p style="margin: 0; color: #111; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(feedback.message)}</p>
                </div>
              </div>

              <div style="margin-bottom: 30px;">
                <p style="font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px;">
                  USER CONTEXT
                </p>
                <table width="100%" border="0" cellpadding="0" cellspacing="0" style="font-size: 13px;">
                  <tr>
                    <td style="padding: 8px 0; color: #666; width: 40%;">User Name:</td>
                    <td style="padding: 8px 0; color: #111; font-weight: 500;">${escapeHtml(userInfo.userName)}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">User Email:</td>
                    <td style="padding: 8px 0; color: #111;">${escapeHtml(userInfo.userEmail)}</td>
                  </tr>
                  ${userInfo.organisationName ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Organisation:</td>
                    <td style="padding: 8px 0; color: #111; font-weight: 500;">${escapeHtml(userInfo.organisationName)}</td>
                  </tr>
                  ` : ''}
                  ${userInfo.locationName ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Location:</td>
                    <td style="padding: 8px 0; color: #111; font-weight: 500;">${escapeHtml(userInfo.locationName)}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="padding: 8px 0; color: #999; font-size: 11px;">User ID (Auth):</td>
                    <td style="padding: 8px 0; color: #999; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(authUserId)}</td>
                  </tr>
                  ${feedback.userId ? `
                  <tr>
                    <td style="padding: 8px 0; color: #999; font-size: 11px;">User ID (Client):</td>
                    <td style="padding: 8px 0; color: #999; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(feedback.userId)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.organisationId ? `
                  <tr>
                    <td style="padding: 8px 0; color: #999; font-size: 11px;">Organisation ID:</td>
                    <td style="padding: 8px 0; color: #999; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(feedback.organisationId)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.locationId ? `
                  <tr>
                    <td style="padding: 8px 0; color: #999; font-size: 11px;">Location ID:</td>
                    <td style="padding: 8px 0; color: #999; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(feedback.locationId)}</td>
                  </tr>
                  ` : ''}
                </table>
              </div>

              <div style="margin-bottom: 30px;">
                <p style="font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px;">
                  TECHNICAL CONTEXT
                </p>
                <table width="100%" border="0" cellpadding="0" cellspacing="0" style="font-size: 13px;">
                  ${feedback.pathname ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666; width: 40%;">Route:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(feedback.pathname)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.fullUrl ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Full URL:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(feedback.fullUrl)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.environment ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Environment:</td>
                    <td style="padding: 8px 0; color: #111;">${escapeHtml(feedback.environment)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.userAgent ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">User Agent:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(feedback.userAgent)}</td>
                  </tr>
                  ` : ''}
                  ${feedback.screenWidth && feedback.screenHeight ? `
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Screen Resolution:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px;">${feedback.screenWidth} × ${feedback.screenHeight}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Timestamp:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px;">${formatDate(feedback.timestamp)}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Feedback ID:</td>
                    <td style="padding: 8px 0; color: #111; font-family: 'Menlo', monospace; font-size: 11px;">${escapeHtml(feedbackId)}</td>
                  </tr>
                </table>
              </div>

            </td>
          </tr>

          <tr>
            <td style="background-color: #111111; padding: 30px; text-align: center;">
              <p style="color: #666; font-size: 13px; margin: 0;">
                Feedback submitted via the nxt dashboard
              </p>
            </td>
          </tr>

        </table>
        
        <p style="margin-top: 30px; font-size: 11px; color: #aaa; text-align: center; font-family: 'Menlo', monospace;">
          POWERED BY THE NXT
        </p>

      </td>
    </tr>
  </table>

</body>
</html>
  `;

  let text = `Feedback Submitted\n\n`;
  text += `Reference Type: ${feedback.referenceType}\n`;
  text += `Feedback ID: ${feedbackId}\n`;
  text += `Timestamp: ${formatDate(feedback.timestamp)}\n\n`;
  text += `Message:\n`;
  text += `${'='.repeat(50)}\n`;
  text += `${feedback.message}\n\n`;
  text += `User Context:\n`;
  text += `${'='.repeat(50)}\n`;
  text += `User Name: ${userInfo.userName}\n`;
  text += `User Email: ${userInfo.userEmail}\n`;
  if (userInfo.organisationName) text += `Organisation: ${userInfo.organisationName}\n`;
  if (userInfo.locationName) text += `Location: ${userInfo.locationName}\n`;
  text += `\nTechnical Details:\n`;
  text += `${'='.repeat(50)}\n`;
  text += `User ID (Auth): ${authUserId}\n`;
  if (feedback.userId) text += `User ID (Client): ${feedback.userId}\n`;
  if (feedback.organisationId) text += `Organisation ID: ${feedback.organisationId}\n`;
  if (feedback.locationId) text += `Location ID: ${feedback.locationId}\n`;
  text += `\nTechnical Context:\n`;
  text += `${'='.repeat(50)}\n`;
  if (feedback.pathname) text += `Route: ${feedback.pathname}\n`;
  if (feedback.fullUrl) text += `Full URL: ${feedback.fullUrl}\n`;
  if (feedback.environment) text += `Environment: ${feedback.environment}\n`;
  if (feedback.userAgent) text += `User Agent: ${feedback.userAgent}\n`;
  if (feedback.screenWidth && feedback.screenHeight) {
    text += `Screen Resolution: ${feedback.screenWidth} × ${feedback.screenHeight}\n`;
  }
  text += `Timestamp: ${formatDate(feedback.timestamp)}\n\n`;
  text += `POWERED BY THE NXT\n`;

  return {
    subject,
    html,
    text,
  };
};

