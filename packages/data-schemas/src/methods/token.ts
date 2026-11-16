import type { ClientSession, QueryOptions } from 'mongoose';
import { IToken, TokenCreateData, TokenQuery, TokenUpdateData, TokenDeleteResult } from '~/types';
import logger from '~/config/winston';

// Factory function that takes mongoose instance and returns the methods
export function createTokenMethods(mongoose: typeof import('mongoose')): {
  findToken: (query: TokenQuery, options?: QueryOptions) => Promise<IToken | null>;
  createToken: (tokenData: TokenCreateData, session?: ClientSession) => Promise<IToken>;
  updateToken: (
    query: TokenQuery,
    updateData: TokenUpdateData,
    session?: ClientSession,
  ) => Promise<IToken | null>;
  deleteTokens: (query: TokenQuery, session?: ClientSession) => Promise<TokenDeleteResult>;
} {
  /**
   * Creates a new Token instance.
   */
  async function createToken(tokenData: TokenCreateData, session?: ClientSession): Promise<IToken> {
    try {
      const Token = mongoose.models.Token;
      const currentTime = new Date();
      const expiresAt = new Date(currentTime.getTime() + tokenData.expiresIn * 1000);

      const newTokenData = {
        ...tokenData,
        createdAt: currentTime,
        expiresAt,
      };

      if (!session) return await Token.create(newTokenData);
      const [token] = await Token.create([newTokenData], { session });
      return token;
    } catch (error) {
      logger.debug('An error occurred while creating token:', error);
      throw error;
    }
  }

  /**
   * Updates a Token document that matches the provided query.
   */
  async function updateToken(
    query: TokenQuery,
    updateData: TokenUpdateData,
    session?: ClientSession,
  ): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;

      const dataToUpdate = { ...updateData };
      if (updateData?.expiresIn !== undefined) {
        dataToUpdate.expiresAt = new Date(Date.now() + updateData.expiresIn * 1000);
      }

      return await Token.findOneAndUpdate(query, dataToUpdate, {
        new: true,
        ...(session && { session }),
      });
    } catch (error) {
      logger.debug('An error occurred while updating token:', error);
      throw error;
    }
  }

  /** Deletes all Token documents matching every provided field (AND semantics). */
  async function deleteTokens(
    query: TokenQuery,
    session?: ClientSession,
  ): Promise<TokenDeleteResult> {
    try {
      const Token = mongoose.models.Token;
      const conditions = [];

      if (query.userId !== undefined) {
        conditions.push({ userId: query.userId });
      }
      if (query.token !== undefined) {
        conditions.push({ token: query.token });
      }
      if (query.email !== undefined) {
        const email = query.email === null ? null : query.email.trim().toLowerCase();
        conditions.push({ email });
      }
      if (query.type !== undefined) {
        conditions.push({ type: query.type });
      }
      if (query.identifier !== undefined) {
        conditions.push({ identifier: query.identifier });
      }

      if (conditions.length === 0) {
        throw new Error('At least one query parameter must be provided');
      }

      const deletion = Token.deleteMany({ $and: conditions });
      return await (session ? deletion.session(session) : deletion);
    } catch (error) {
      logger.debug('An error occurred while deleting tokens:', error);
      throw error;
    }
  }

  /**
   * Finds a Token document that matches the provided query.
   * Email is automatically normalized to lowercase for case-insensitive matching.
   */
  async function findToken(query: TokenQuery, options?: QueryOptions): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;
      const conditions = [];

      if (query.userId) {
        conditions.push({ userId: query.userId });
      }
      if (query.token) {
        conditions.push({ token: query.token });
      }
      if (query.email !== undefined) {
        const email = query.email === null ? null : query.email.trim().toLowerCase();
        conditions.push({ email });
      }
      if (query.type !== undefined) {
        conditions.push({ type: query.type });
      }
      if (query.identifier !== undefined) {
        conditions.push({ identifier: query.identifier });
      }

      const token = await Token.findOne({ $and: conditions }, null, options).lean();

      return token as IToken | null;
    } catch (error) {
      logger.debug('An error occurred while finding token:', error);
      throw error;
    }
  }

  // Return all methods
  return {
    findToken,
    createToken,
    updateToken,
    deleteTokens,
  };
}

export type TokenMethods = ReturnType<typeof createTokenMethods>;
