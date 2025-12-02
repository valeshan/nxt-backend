import { FastifyRequest, FastifyReply } from 'fastify';
import { invoicePipelineService } from '../services/InvoicePipelineService';

export const invoiceController = {
  async upload(req: FastifyRequest, reply: FastifyReply) {
    const { locationId } = req.params as { locationId: string };
    const auth = req.authContext;
    
    if (!auth || !auth.organisationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Basic access check: verify location belongs to org or user has access
    // Assuming auth middleware handles org scope.
    
    const data = await req.file();
    if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Log incoming file metadata
    req.log.info({
        msg: 'Incoming invoice upload',
        fileName: data.filename,
        mimeType: data.mimetype,
        locationId,
        organisationId: auth.organisationId,
        fileStreamReadable: data.file?.readable
    });
    
    // Additional validation
    if (data.mimetype !== 'application/pdf') {
        return reply.status(400).send({ error: 'Only PDF files up to 10MB are supported' });
    }

    try {
        const result = await invoicePipelineService.submitForProcessing(data.file, {
            organisationId: auth.organisationId,
            locationId,
            fileName: data.filename,
            mimeType: data.mimetype,
        });
        return reply.status(202).send(result);
    } catch (e: any) {
        req.log.error({
            msg: 'Upload processing failed',
            error: e.name,
            message: e.message,
            stack: e.stack,
            stage: e.stage || 'unknown',
            awsCode: e.awsCode
        });
        return reply.status(500).send({ error: 'Upload processing failed' });
    }
  },

  async getStatus(req: FastifyRequest, reply: FastifyReply) {
     const { id } = req.params as { id: string };
     
     try {
         const result = await invoicePipelineService.pollProcessing(id);
         return result;
     } catch (e: any) {
         if (e.name === 'InvoiceFileNotFoundError' || e.message === 'Invoice file not found') {
             return reply.status(404).send({ error: 'Invoice file not found' });
         }
         throw e;
     }
  },

  async verify(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      
      req.log.info({ 
        msg: 'Verify invoice requested',
        invoiceId: id,
        params: req.params,
        body 
      });

      try {
          const result = await invoicePipelineService.verifyInvoice(id, body);
          
          if (!result) {
            req.log.warn({ msg: 'Invoice not found during verify', invoiceId: id });
            return reply.status(404).send({ error: 'Invoice not found' });
          }

          return result;
      } catch (e: any) {
          // Pass through specific error messages if possible
          if (e.message === 'Invoice not found') {
             return reply.status(404).send({ error: 'Invoice not found' });
          }
          throw e;
      }
  },

  async list(req: FastifyRequest, reply: FastifyReply) {
      const { locationId } = req.params as { locationId: string };
      const { page, limit } = req.query as { page?: number, limit?: number };
      
      const result = await invoicePipelineService.listInvoices(locationId, page, limit);
      return result;
  }
};

