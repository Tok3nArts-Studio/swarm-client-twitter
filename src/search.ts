import { QueryTweetsResponse, SearchMode, Tweet } from "agent-twitter-client";
import { composeContext, elizaLogger, Memory } from "@elizaos/core";
import { generateMessageResponse, generateText } from "@elizaos/core";
import { messageCompletionFooter } from "@elizaos/core";
import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type IImageDescriptionService,
  ModelClass,
  ServiceType,
  type State,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

const twitterSearchTemplate =
  `# Areas of Expertise 
				{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
				{{bio}}
				{{lore}}
				{{topics}}
				{{adjectives}}
				
				



# Task: Generate a reply to a relevant tweet in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
						Each sentence must:
						- Be on its own line
						- Have an empty line after it
						- end with an engaging question
						Avoid hashtags. Make each line a standalone, and use exclamation points when appropriate. Keep total length under {{maxTweetLength}} characters.
						Your response should be 2 or 3 sentences (choose the length at random).
						Your response should  contain engaging qusestions that spark conversation every third response. Radical, Direct, urgent and strongly passionate tone. The total character count MUST be less than {{maxTweetLength}}.
						Generate a reply in the voice and style of {{agentName}} (@{{twitterUserName}}).
						Write a reply that is {{adjective}} about {{topic}} (mentioning {{topic}} directly), from the perspective of {{agentName}}. Use 1 or 2 sentences max.
                        Use emojis sparangly.
                        Ask engaging questions every third response.
                        Do not be poetic.
                        Do not be verbose.
                        Do not be long.
                        Do not be wordy.
                        Do not be peotic.
                        Do not use comparisons.
                       
                        IMPORTANT: Your response CANNOT be longer than 30 words.
Aim for 2-3 short sentences maximum. Be radical and direct.

Your response should contain engaging questions every 3 responses. Informative, interesting, and engaging statements only. Emojis every 3 responses. Use \n\n (double spaces) between statements.` +
  messageCompletionFooter;

export class TwitterSearchClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private respondedTweets: Set<string> = new Set();

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
  }

  async start() {
    if (
      this.client.twitterConfig.TWITTER_DISABLE_TOPIC_SEARCH &&
      this.client.twitterConfig.TWITTER_DISABLE_TIMELINE_SEARCH
    ) {
      elizaLogger.log("Twitter topic and timeline search are disabled");
      return;
    }

    this.engageWithSearchTermsLoop();
  }

  private engageWithSearchTermsLoop() {
    this.engageWithSearchTerms().then();

    const searchIntervalMin =
      this.client.twitterConfig.TWITTER_SEARCH_INTERVAL_MIN;
    const searchIntervalMax =
      this.client.twitterConfig.TWITTER_SEARCH_INTERVAL_MAX;

    const randomMinutes =
      Math.floor(Math.random() * (searchIntervalMax - searchIntervalMin + 1)) +
      searchIntervalMin;

    elizaLogger.log(
      `Next twitter search scheduled in ${randomMinutes} minutes - randomized between ${searchIntervalMin} and ${searchIntervalMax} minutes`
    );
    setTimeout(
      () => this.engageWithSearchTermsLoop(),
      randomMinutes * 60 * 1000
    );
  }

  private async engageWithSearchTerms() {
    elizaLogger.log("Engaging with search terms");
    const topicSearchDisabled =
      this.client.twitterConfig.TWITTER_DISABLE_TOPIC_SEARCH;
    const timelineSearchDisabled =
      this.client.twitterConfig.TWITTER_DISABLE_TIMELINE_SEARCH;

    try {
      let recentTweets: QueryTweetsResponse = { tweets: [] };
      const searchTerm = [...this.runtime.character.topics][
        Math.floor(Math.random() * this.runtime.character.topics.length)
      ];

      if (topicSearchDisabled) {
        elizaLogger.log("Topic search is disabled");
      } else {
        elizaLogger.log("Fetching search tweets - search term:", searchTerm);
        // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
        await new Promise((resolve) => setTimeout(resolve, 5000));
        recentTweets = await this.client.fetchSearchTweets(
          searchTerm,
          20,
          SearchMode.Top
        );
        elizaLogger.log("Search tweets fetched");
      }

      let homeTimeline: Tweet[] = [];

      if (timelineSearchDisabled) {
        elizaLogger.log("Timeline search is disabled");
      } else {
        homeTimeline = await this.client.fetchHomeTimeline(50);
      }

      await this.client.cacheTimeline(homeTimeline);

      const formattedHomeTimeline =
        `# ${this.runtime.character.name}'s Home Timeline\n\n` +
        homeTimeline
          .map((tweet) => {
            return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${
              tweet.inReplyToStatusId
                ? ` In reply to: ${tweet.inReplyToStatusId}`
                : ""
            }\nText: ${tweet.text}\n---\n`;
          })
          .join("\n");

      // randomly slice .tweets down to 20
      const slicedTweets = recentTweets.tweets
        .sort(() => Math.random() - 0.5)
        .slice(0, 20);

      if (!topicSearchDisabled && slicedTweets.length === 0) {
        elizaLogger.log(
          "No valid tweets found for the search term",
          searchTerm
        );
        // return;
      }

      const prompt = `
  Here are some tweets related to the search term "${searchTerm}":

  ${[...slicedTweets, ...homeTimeline]
    .filter((tweet) => {
      // ignore tweets where any of the thread tweets contain a tweet by the bot
      const thread = tweet.thread;
      const botTweet = thread.find((t) => t.username === this.twitterUsername);
      return !botTweet;
    })
    .map(
      (tweet) => `
    ID: ${tweet.id}${
        tweet.inReplyToStatusId
          ? ` In reply to: ${tweet.inReplyToStatusId}`
          : ""
      }
    From: ${tweet.name} (@${tweet.username})
    Text: ${tweet.text}
  `
    )
    .join("\n")}

  Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
  Notes:
    - Respond to English tweets only
    - Respond to tweets that don't have a lot of hashtags, links, URLs or images
    - Respond to tweets that are not retweets
    - Respond to tweets where there is an easy exchange of ideas to have with the user
    - ONLY respond with the ID of the tweet`;

      const mostInterestingTweetResponse = await generateText({
        runtime: this.runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      const tweetId = mostInterestingTweetResponse.trim();
      const selectedTweet = slicedTweets.find(
        (tweet) =>
          tweet.id.toString().includes(tweetId) ||
          tweetId.includes(tweet.id.toString())
      );

      if (!selectedTweet) {
        elizaLogger.warn("No matching tweet found for the selected ID");
        elizaLogger.log("Selected tweet ID:", tweetId);
        return;
      }

      elizaLogger.log(
        `Selected tweet to reply to [${selectedTweet?.id}]:`,
        selectedTweet?.text
      );

      // Generate a unique memory ID for the selected tweet using its ID and the agent's ID
      const memoryId = stringToUuid(
        selectedTweet.id + "-" + this.runtime.agentId
      );

      // Check if the tweet has already been processed by looking for an existing memory
      const existingResponse = await this.runtime.messageManager.getMemoryById(
        memoryId
      );

      // If a response already exists, log a message and skip further processing
      if (existingResponse) {
        elizaLogger.log(
          `Already responded to tweet ${selectedTweet.id}, skipping`
        );
        return;
      }

      if (selectedTweet.username === this.twitterUsername) {
        elizaLogger.log("Skipping tweet from bot itself");
        return;
      }

      const conversationId = selectedTweet.conversationId;
      const roomId = stringToUuid(conversationId + "-" + this.runtime.agentId);

      const userIdUUID = stringToUuid(selectedTweet.userId as string);

      await this.runtime.ensureConnection(
        userIdUUID,
        roomId,
        selectedTweet.username,
        selectedTweet.name,
        "twitter"
      );

      // crawl additional conversation tweets, if there are any
      await buildConversationThread(selectedTweet, this.client);

      const message = {
        id: memoryId,
        agentId: this.runtime.agentId,
        content: {
          text: selectedTweet.text,
          url: selectedTweet.permanentUrl,
          inReplyTo: selectedTweet.inReplyToStatusId
            ? stringToUuid(
                selectedTweet.inReplyToStatusId + "-" + this.runtime.agentId
              )
            : undefined,
        },
        userId: userIdUUID,
        roomId,
        // Timestamps are in seconds, but we need them in milliseconds
        createdAt: selectedTweet.timestamp * 1000,
      };

      if (!message.content.text) {
        elizaLogger.warn("Returning: No response text found");
        return;
      }

      // Fetch replies and retweets
      const replies = selectedTweet.thread;
      const replyContext = replies
        .filter((reply) => reply.username !== this.twitterUsername)
        .map((reply) => `@${reply.username}: ${reply.text}`)
        .join("\n");

      let tweetBackground = "";
      if (selectedTweet.isRetweet) {
        const originalTweet = await this.client.requestQueue.add(() =>
          this.client.twitterClient.getTweet(selectedTweet.id)
        );
        tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
      }

      // Generate image descriptions using GPT-4 vision API
      const imageDescriptions = [];
      for (const photo of selectedTweet.photos) {
        const description = await this.runtime
          .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
          .describeImage(photo.url);
        imageDescriptions.push(description);
      }

      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.twitterUsername,
        timeline: formattedHomeTimeline,
        tweetContext: `${tweetBackground}

  Original Post:
  By @${selectedTweet.username}
  ${selectedTweet.text}${
          replyContext.length > 0 &&
          `\nReplies to original post:\n${replyContext}`
        }
  ${`Original post text: ${selectedTweet.text}`}
  ${
    selectedTweet.urls.length > 0
      ? `URLs: ${selectedTweet.urls.join(", ")}\n`
      : ""
  }${
          imageDescriptions.length > 0
            ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n`
            : ""
        }
  `,
      });

      await this.client.saveRequestMessage(message, state as State);

      const context = composeContext({
        state,
        template:
          this.runtime.character.templates?.twitterSearchTemplate ||
          twitterSearchTemplate,
      });

      const responseContent = await generateMessageResponse({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.LARGE,
      });

      responseContent.inReplyTo = message.id;

      const response = responseContent;

      if (!response.text) {
        elizaLogger.warn("Returning: No response text found");
        return;
      }

      elizaLogger.log(
        `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
      );
      try {
        const callback: HandlerCallback = async (
          response: Content
        ): Promise<Memory[]> => {
          const memories = await sendTweet(
            this.client,
            response,
            message.roomId,
            this.twitterUsername,
            selectedTweet.id
          );
          return memories;
        };

        const responseMessages = await callback(responseContent);

        state = await this.runtime.updateRecentMessageState(state);

        for (const responseMessage of responseMessages) {
          await this.runtime.messageManager.createMemory(
            responseMessage,
            false
          );
        }

        if (
          !this.client.twitterConfig.TWITTER_DISABLE_FOLLOW_AFTER_SEARCH_REPLY
        ) {
          try {
            elizaLogger.log(
              `Following user ${selectedTweet.username} after replying to their tweet`
            );
            await this.client.twitterClient.followUser(selectedTweet.username);
          } catch (error) {
            elizaLogger.error(
              `Error following user ${selectedTweet.username} after replying to their tweet: ${error}`
            );
          }
        } else {
          elizaLogger.log(
            `Skipping follow for user ${selectedTweet.username} after replying to their tweet`
          );
        }

        state = await this.runtime.updateRecentMessageState(state);

        await this.runtime.evaluate(message, state);

        await this.runtime.processActions(
          message,
          responseMessages,
          state,
          callback
        );

        this.respondedTweets.add(selectedTweet.id);
        const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;

        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${selectedTweet.id}.txt`,
          responseInfo
        );

        await wait();
      } catch (error) {
        console.error(`Error sending response post: ${error}`);
      }
    } catch (error) {
      console.error("Error engaging with search terms:", error);
    }
  }
}
