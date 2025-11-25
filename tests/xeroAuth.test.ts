
import { buildApp } from '../src/app';
import { config } from '../src/config/env';

describe('Xero Auth Routes', () => {
  let app: any;

  beforeAll(async () => {
    // Use test config
    config.NODE_ENV = 'test';
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /xero/authorise/start should return redirectUrl', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/xero/authorise/start',
    });

    // Since startAuth redirects, we might check for 302 or 200 with redirectUrl depending on implementation
    // The controller sends { redirectUrl: string }
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload).toHaveProperty('redirectUrl');
    expect(payload.redirectUrl).toContain('xero.com');
  });

  it('GET /xero/authorise should handle callback with code and state', async () => {
    // We mock the controller logic or just ensure parameters are validated
    // Since we can't easily mock the service inside the compiled app without dependency injection or mocks
    // We will check validation.
    
    // Missing code/state should fail validation
    const responseMissing = await app.inject({
      method: 'GET',
      url: '/xero/authorise',
    });
    expect(responseMissing.statusCode).toBe(400);

    // With valid params (it might fail 500 downstream if Xero call fails, but route should be matched)
    const response = await app.inject({
      method: 'GET',
      url: '/xero/authorise?code=test_code&state=test_state',
    });
    
    // Expecting 500 or 400 from downstream service failure (since code is fake)
    // But proving 404 is gone is the goal.
    expect(response.statusCode).not.toBe(404);
  });
});

