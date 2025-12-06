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
      // Extract all relevant fields from body
      const { supplierId, supplierName, total, createAlias, aliasName, selectedLineItemIds, date, items } = req.body as any;
      
      if (selectedLineItemIds !== undefined && !Array.isArray(selectedLineItemIds)) {
          return reply.status(400).send({ error: 'selectedLineItemIds must be an array of strings' });
      }

      if (items !== undefined && !Array.isArray(items)) {
          return reply.status(400).send({ error: 'items must be an array of objects' });
      }

      req.log.info({ 
        msg: 'Verify invoice requested',
        invoiceId: id,
        params: req.params,
        body: req.body 
      });

      try {
          const result = await invoicePipelineService.verifyInvoice(id, {
              supplierId,
              supplierName,
              total,
              createAlias,
              aliasName,
              selectedLineItemIds,
              date,
              items
          });
          
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
          // Handle the validation error we added
          if (e.message === "Supplier is required (either supplierId or supplierName)" || 
              e.message === "At least one line item must be selected" ||
              e.message.startsWith("Invalid line items")) {
              return reply.status(400).send({ error: e.message });
          }
          throw e;
      }
  },

  async list(req: FastifyRequest, reply: FastifyReply) {
      const { locationId } = req.params as { locationId: string };
      const { page, limit } = req.query as { page?: number, limit?: number };
      
      const result = await invoicePipelineService.listInvoices(locationId, page, limit);
      return result;
  },

  async delete(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          await invoicePipelineService.deleteInvoice(id, auth.organisationId);
          return reply.status(200).send({ success: true });
      } catch (e: any) {
          req.log.error({
              msg: 'Delete invoice failed',
              invoiceId: id,
              error: e.message
          });

          if (e.message === 'Invoice not found or access denied') {
              return reply.status(404).send({ error: e.message });
          }
          
          return reply.status(500).send({ error: 'Failed to delete invoice' });
      }
  }
};

