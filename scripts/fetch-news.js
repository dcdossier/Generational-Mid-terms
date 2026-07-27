#!/usr/bin/env node
'use strict';

/**
 * fetch-news.js
 * Fetches RSS feeds from 154 national and state-level sources (midterm_rss_feeds_v2.xlsx),
 * filters for midterm-relevant items, auto-tags them, deduplicates against existing
 * data.json, and writes the updated news array back to data.json.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const DATA_PATH = path.resolve(__dirname, '../data.json');

// ── RSS SOURCES ────────────────────────────────────────────────────────────────
// Generated from midterm_rss_feeds_v2.xlsx (v2)
// Columns: source name, feed URL, state/level
const FEEDS = [

  // NATIONAL NEWS
  { url: 'https://thehill.com/feed/',                                                                                               source: 'The Hill' },
  { url: 'https://thehill.com/homenews/house/feed/',                                                                               source: 'The Hill (House)' },
  { url: 'https://thehill.com/homenews/senate/feed/',                                                                              source: 'The Hill (Senate)' },
  { url: 'https://rss.politico.com/congress.xml',                                                                                  source: 'Politico' },
  { url: 'https://rss.politico.com/politics-news.xml',                                                                             source: 'Politico Elections' },
  { url: 'https://api.axios.com/feed/',                                                                                            source: 'Axios' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:apnews.com+congress+midterm',                       source: 'AP News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:reuters.com+congress+midterm',                      source: 'Reuters' },
  { url: 'https://rollcall.com/feed/',                                                                                             source: 'Roll Call' },
  { url: 'https://ballotpedia.org/wiki/index.php?title=Special:RecentChanges&feed=rss',                                            source: 'Ballotpedia' },
  { url: 'https://www.theguardian.com/us-news/us-politics/rss',                                                                    source: 'The Guardian' },

  // NATIONAL POLLING
  { url: 'https://www.realclearpolitics.com/xml/rss.xml',                                                                         source: 'RealClearPolitics' },
  { url: 'https://www.pewresearch.org/feed/',                                                                                      source: 'Pew Research' },
  { url: 'https://news.gallup.com/rss/gallup_politics_rss.xml',                                                                   source: 'Gallup' },
  { url: 'https://yougov.com/en-us/rss',                                                                                          source: 'YouGov' },
  { url: 'https://www.cookpolitical.com/feed',                                                                                     source: 'Cook Political Report' },
  { url: 'https://insideelections.com/feed/',                                                                                      source: 'Inside Elections' },
  { url: 'https://centerforpolitics.org/crystalball/feed/',                                                                        source: "Sabato's Crystal Ball" },
  { url: 'https://www.brookings.edu/feed/',                                                                                        source: 'Brookings' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Politico+poll+congress+senate+house+2026',               source: 'Politico Polling' },

  // ARIZONA
  { url: 'https://azmirror.com/feed/localFeed/',                                                                                   source: 'Arizona Mirror' },
  { url: 'https://azcapitoltimes.com/feed/',                                                                                       source: 'Arizona Capitol Times' },
  { url: 'https://www.azcentral.com/arcio/rss/',                                                                                   source: 'Arizona Republic' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Arizona+2026',                              source: 'Emerson (AZ)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Arizona+2026',                           source: 'Quinnipiac (AZ)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Arizona+2026',                              source: 'Suffolk (AZ)' },

  // CALIFORNIA
  { url: 'https://calmatters.org/feed/',                                                                                           source: 'CalMatters' },
  { url: 'https://www.latimes.com/rss2.0.xml',                                                                                    source: 'Los Angeles Times' },
  { url: 'https://www.sacbee.com/arcio/rss/',                                                                                     source: 'Sacramento Bee' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Berkeley+IGS+poll+California+2026',                      source: 'UC Berkeley IGS Poll' },
  { url: 'https://www.ppic.org/feed/',                                                                                             source: 'PPIC' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+California+2026',                           source: 'Emerson (CA)' },

  // COLORADO
  { url: 'https://coloradosun.com/feed/',                                                                                          source: 'Colorado Sun' },
  { url: 'https://www.coloradopolitics.com/feed/',                                                                                 source: 'Colorado Politics' },
  { url: 'https://cpr.org/feed/',                                                                                                  source: 'CPR News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Colorado+2026',                             source: 'Emerson (CO)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Colorado+2026',                          source: 'Quinnipiac (CO)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Colorado+2026',                             source: 'Suffolk (CO)' },

  // FLORIDA
  { url: 'https://floridapolitics.com/feed/',                                                                                      source: 'Florida Politics' },
  { url: 'https://floridaphoenix.com/feed/localFeed/',                                                                             source: 'Florida Phoenix' },
  { url: 'https://www.tampabay.com/feed/',                                                                                         source: 'Tampa Bay Times' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Stetson+poll+Florida+2026',                              source: 'Stetson Poll (FL)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Florida+2026',                              source: 'Emerson (FL)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Florida+2026',                           source: 'Quinnipiac (FL)' },

  // GEORGIA
  { url: 'https://georgiarecorder.com/feed/localFeed/',                                                                            source: 'Georgia Recorder' },
  { url: 'https://www.ajc.com/arcio/rss/',                                                                                        source: 'Atlanta Journal-Constitution' },
  { url: 'https://www.gpb.org/rss.xml',                                                                                           source: 'GPB News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Georgia+2026',                              source: 'Emerson (GA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Georgia+2026',                           source: 'Quinnipiac (GA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Georgia+2026',                              source: 'Suffolk (GA)' },

  // IOWA
  { url: 'https://iowacapitaldispatch.com/feed/localFeed/',                                                                        source: 'Iowa Capital Dispatch' },
  { url: 'https://iowastartingline.com/feed/',                                                                                     source: 'Iowa Starting Line' },
  { url: 'http://www.thegazette.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                       source: 'The Gazette (IA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Selzer+poll+Iowa+2026',                                  source: 'Selzer (IA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Iowa+2026',                                 source: 'Emerson (IA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Iowa+2026',                              source: 'Quinnipiac (IA)' },

  // MAINE
  { url: 'https://mainemorningstar.com/feed/localFeed/',                                                                           source: 'Maine Morning Star' },
  { url: 'https://www.pressherald.com/feed/',                                                                                      source: 'Portland Press Herald' },
  { url: 'https://www.bangordailynews.com/feed/',                                                                                  source: 'Bangor Daily News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Maine+2026',                                source: 'Emerson (ME)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Maine+2026',                                source: 'Suffolk (ME)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Maine+2026',                             source: 'Quinnipiac (ME)' },

  // MICHIGAN
  { url: 'https://bridgemi.com/feed/',                                                                                             source: 'Bridge Michigan' },
  { url: 'https://michiganadvance.com/feed/localFeed/',                                                                            source: 'Michigan Advance' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:detroitnews.com+Michigan+election+2026',            source: 'Detroit News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=EPIC-MRA+poll+Michigan+2026',                            source: 'EPIC-MRA (MI)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Glengariff+poll+Michigan+2026',                          source: 'Glengariff (MI)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Michigan+2026',                          source: 'Quinnipiac (MI)' },

  // MONTANA
  { url: 'https://montanafreepress.org/feed/',                                                                                     source: 'Montana Free Press' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:billingsgazette.com+Montana+election+2026',         source: 'Billings Gazette' },
  { url: 'https://www.mtpr.org/index.rss',                                                                                        source: 'Montana Public Radio' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Montana+2026',                              source: 'Emerson (MT)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Montana+2026',                           source: 'Quinnipiac (MT)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Montana+2026',                              source: 'Suffolk (MT)' },

  // NEBRASKA
  { url: 'https://nebraskaexaminer.com/feed/localFeed/',                                                                           source: 'Nebraska Examiner' },
  { url: 'http://omaha.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                                source: 'Omaha World-Herald' },
  { url: 'http://journalstar.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                          source: 'Lincoln Journal Star' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Selzer+poll+Nebraska+2026',                              source: 'Selzer (NE)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Siena+poll+Nebraska+2026',                               source: 'Siena/NYT (NE)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Nebraska+2026',                             source: 'Emerson (NE)' },

  // NEVADA
  { url: 'https://thenevadaindependent.com/feed/',                                                                                 source: 'Nevada Independent' },
  { url: 'https://nevadacurrent.com/feed/localFeed/',                                                                              source: 'Nevada Current' },
  { url: 'https://www.reviewjournal.com/feed/',                                                                                    source: 'Las Vegas Review-Journal' },
  { url: 'https://thenevadaindependent.com/articles/polls/feed/',                                                                  source: 'Nevada Ind. Polls' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Nevada+2026',                               source: 'Emerson (NV)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Nevada+2026',                            source: 'Quinnipiac (NV)' },

  // NEW HAMPSHIRE
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:unionleader.com+New+Hampshire+election+2026',       source: 'NH Union Leader' },
  { url: 'https://www.concordmonitor.com/feed/',                                                                                   source: 'Concord Monitor' },
  { url: 'https://newhampshirebulletin.com/feed/localFeed/',                                                                       source: 'NH Bulletin' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Saint+Anselm+NHIOP+poll+New+Hampshire+2026',             source: 'Saint Anselm NHIOP' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UNH+Survey+Center+poll+New+Hampshire+2026',              source: 'UNH Survey Center' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Hampshire+2026',                        source: 'Suffolk (NH)' },

  // NEW JERSEY
  { url: 'https://njspotlightnews.org/feed/',                                                                                      source: 'NJ Spotlight News' },
  { url: 'https://njmonitor.com/feed/',                                                                                            source: 'NJ Monitor' },
  { url: 'https://insidernj.com/feed/',                                                                                            source: 'Insider NJ' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Monmouth+poll+New+Jersey+2026',                          source: 'Monmouth (NJ)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+Jersey+2026',                        source: 'Quinnipiac (NJ)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Jersey+2026',                           source: 'Suffolk (NJ)' },

  // NEW MEXICO
  { url: 'https://nmpoliticalreport.com/feed/',                                                                                    source: 'NM Political Report' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:abqjournal.com+New+Mexico+election+2026',           source: 'Albuquerque Journal' },
  { url: 'https://sourcenm.com/feed/localFeed/',                                                                                   source: 'Source New Mexico' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+New+Mexico+2026',                           source: 'Emerson (NM)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Mexico+2026',                           source: 'Suffolk (NM)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+Mexico+2026',                        source: 'Quinnipiac (NM)' },

  // NEW YORK
  { url: 'https://www.cityandstateny.com/rss.xml',                                                                                source: 'City & State NY' },
  { url: 'https://nystateofpolitics.com/feed/',                                                                                    source: 'NY State of Politics' },
  { url: 'https://www.timesunion.com/rss/',                                                                                       source: 'Times Union (Albany)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Siena+poll+New+York+2026',                               source: 'Siena College (NY)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+York+2026',                          source: 'Quinnipiac (NY)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Marist+poll+New+York+2026',                              source: 'Marist Poll (NY)' },

  // NORTH CAROLINA
  { url: 'https://ncnewsline.com/feed/localFeed/',                                                                                 source: 'NC Newsline' },
  { url: 'https://carolinapublicpress.org/feed/',                                                                                  source: 'Carolina Public Press' },
  { url: 'https://www.wunc.org/politics.rss',                                                                                     source: 'WUNC Politics' },
  { url: 'https://www.elon.edu/u/elon-poll/feed/',                                                                                source: 'Elon Poll (NC)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Meredith+poll+North+Carolina+2026',                      source: 'Meredith College Poll (NC)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=High+Point+University+poll+North+Carolina+2026',         source: 'HPU Survey Research (NC)' },

  // OHIO
  { url: 'https://ohiocapitaljournal.com/feed/localFeed/',                                                                         source: 'Ohio Capital Journal' },
  { url: 'https://www.cleveland.com/arc/outboundfeeds/rss/',                                                                      source: 'Cleveland Plain Dealer' },
  { url: 'https://www.dispatch.com/arcio/rss/',                                                                                   source: 'Columbus Dispatch' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=BGSU+poll+Ohio+2026',                                    source: 'BGSU Poll (OH)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Ohio+2026',                              source: 'Quinnipiac (OH)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Baldwin+Wallace+poll+Ohio+2026',                         source: 'Baldwin Wallace (OH)' },

  // PENNSYLVANIA
  { url: 'https://www.spotlightpa.org/feeds/full.xml',                                                                            source: 'Spotlight PA' },
  { url: 'https://www.inquirer.com/arcio/rss/',                                                                                   source: 'Philadelphia Inquirer' },
  { url: 'https://www.post-gazette.com/rss',                                                                                      source: 'Pittsburgh Post-Gazette' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Franklin+Marshall+poll+Pennsylvania+2026',               source: 'Franklin & Marshall Poll (PA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Pennsylvania+2026',                      source: 'Quinnipiac (PA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Muhlenberg+poll+Pennsylvania+2026',                      source: 'Muhlenberg Poll (PA)' },

  // TEXAS
  { url: 'https://www.texastribune.org/feed/',                                                                                    source: 'Texas Tribune' },
  { url: 'https://www.houstonchronicle.com/arcio/rss/',                                                                           source: 'Houston Chronicle' },
  { url: 'https://www.texasobserver.org/feed/',                                                                                    source: 'Texas Observer' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UT+Texas+Politics+poll+Texas+2026',                      source: 'UT Texas Politics Poll' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UT+Tyler+poll+Texas+2026',                               source: 'UT Tyler Poll (TX)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Texas+2026',                                source: 'Emerson (TX)' },

  // VIRGINIA
  { url: 'https://virginiamercury.com/feed/localFeed/',                                                                            source: 'Virginia Mercury' },
  { url: 'https://richmond.com/feed/',                                                                                             source: 'Richmond Times-Dispatch' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=VPAP+Virginia+election+2026',                            source: 'VPAP' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=CNU+Wason+poll+Virginia+2026',                           source: 'CNU Wason Center (VA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Virginia+2026',                             source: 'Emerson (VA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Virginia+2026',                             source: 'Suffolk (VA)' },

  // WASHINGTON STATE
  { url: 'https://washingtonstatestandard.com/feed/localFeed/',                                                                    source: 'Washington State Standard' },
  { url: 'https://www.cascadepbs.org/articles/briefs/rss/',                                                                       source: 'Crosscut / Cascade PBS' },
  { url: 'https://www.seattletimes.com/feed/',                                                                                    source: 'Seattle Times' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Elway+Research+poll+Washington+2026',                    source: 'Elway Research (WA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Washington+state+2026',                     source: 'Emerson (WA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Washington+state+2026',                     source: 'Suffolk (WA)' },

  // WISCONSIN
  { url: 'https://wisconsinexaminer.com/feed/localFeed/',                                                                          source: 'Wisconsin Examiner' },
  { url: 'https://www.jsonline.com/arcio/rss/',                                                                                   source: 'Milwaukee Journal Sentinel' },
  { url: 'https://wisconsinwatch.org/feed/',                                                                                      source: 'Wisconsin Watch' },
  { url: 'https://law.marquette.edu/poll/feed/',                                                                                   source: 'Marquette Law Poll (WI)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Wisconsin+2026',                            source: 'Emerson (WI)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Wisconsin+2026',                         source: 'Quinnipiac (WI)' },


  // REDISTRICTING (force-tagged)
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=redistricting+2026+congress', source: 'Google News - Redistricting', forceTags: ['Major Update', 'Redistricting'] },

  // CONNECTICUT (Chris Murphy; new state feeds per India-interest-sources.xlsx)
  { url: 'https://ctmirror.org/feed/',                                                                                                source: 'CT Mirror' },
  { url: 'https://www.courant.com/news/politics/?widgetName=rssfeed&widgetContentId=755799&getXmlFeed=true',                          source: 'Hartford Courant – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Connecticut+2026',                          source: 'Quinnipiac (CT)' },

  // ILLINOIS (Krishnamoorthi, Davis; new state feeds)
  { url: 'https://illinoispolicy.org/feed/',                                                                                          source: 'Illinois Policy Institute' },
  { url: 'https://capitolnewsillinois.com/feed/',                                                                                     source: 'Capitol News Illinois' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Paul+Simon+Institute+poll+Illinois+2026',                   source: 'Paul Simon Institute (IL)' },

  // INDIANA (André Carson; new state feeds)
  { url: 'https://indianacapitalchronicle.com/feed/',                                                                                 source: 'Indiana Capital Chronicle' },
  { url: 'https://www.indystar.com/rss/news/politics/',                                                                               source: 'IndyStar – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Ball+State+CBER+poll+Indiana+2026',                         source: 'Ball State CBER Poll (IN)' },

  // MARYLAND (Van Hollen; new state feeds)
  { url: 'https://www.marylandmatters.org/feed/',                                                                                     source: 'Maryland Matters' },
  { url: 'https://www.wbaltv.com/news/politics/rss.xml',                                                                              source: 'WBAL-TV Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Goucher+poll+Maryland+2026',                                source: 'Goucher College Poll (MD)' },

  // MASSACHUSETTS (Lynch, Markey; new state feeds)
  { url: 'https://www.masslive.com/arc/outboundfeeds/rss/section/politics/',                                                          source: 'MassLive – Politics' },
  { url: 'https://commonwealthbeacon.org/feed/',                                                                                      source: 'CommonWealth Beacon' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=MassINC+poll+Massachusetts+2026',                           source: 'MassINC Polling Group (MA)' },

  // MINNESOTA (Omar; new state feeds)
  { url: 'https://www.minnpost.com/rss.xml',                                                                                          source: 'MinnPost' },
  { url: 'https://www.startribune.com/local/politics/?format=rss',                                                                    source: 'Star Tribune – Politics' },
  { url: 'https://minnesotareformer.com/feed/',                                                                                        source: 'Minnesota Reformer' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Star+Tribune+Minnesota+poll+2026',                          source: 'Star Tribune/MN Poll' },

  // SOUTH CAROLINA (Wilson, Graham; new state feeds)
  { url: 'https://scdailygazette.com/feed/',                                                                                          source: 'SC Daily Gazette' },
  { url: 'https://www.postandcourier.com/politics/feed/',                                                                             source: 'Post and Courier – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Winthrop+poll+South+Carolina+2026',                         source: 'Winthrop University Poll (SC)' },

  // NEW YORK (supplemental — Meeks, Latimer)
  { url: 'https://www.nysfocus.com/feed/',                                                                                             source: 'New York Focus' },
  { url: 'https://maristpoll.marist.edu/feed/',                                                                                        source: 'Marist Poll (NY)' },

  // VIRGINIA (supplemental — Warner, Connolly)
  { url: 'https://cardinalnews.org/feed/',                                                                                             source: 'Cardinal News' },

  // NEW JERSEY (supplemental — Kim, Booker)
  { url: 'https://www.nj.com/arc/outboundfeeds/rss/section/politics/',                                                                source: 'NJ.com – Politics' },
  { url: 'https://www.monmouth.edu/polling-institute/feed/',                                                                           source: 'Monmouth Poll (NJ)' },

  // IDAHO (supplemental — Crapo, Risch)
  { url: 'https://www.idahopress.com/search/?f=rss&t=article&c=news/politics&l=50&s=start_time&sd=desc',                              source: 'Idaho Press – Politics' },

];

// ── RELEVANCE CHECK ──────────────────────────────────────────────────────────
// Word-boundary regex so 'house' does NOT match 'greenhouse'/'housing market',
// 'primary' does NOT match 'primary school/care', etc.
const RELEVANCE_RE = new RegExp([
  // Unambiguous midterm/congressional terms
  '\\b(midterm|congressional|redistrict|gerrymander|filibuster|cloture|caucus)\\b',
  '2026\\s+election', 'election\\s+2026',
  '\\b(119th|120th)\\s+congress\\b',
  // "The House" / "The Senate" / "US House" — explicit institutional references
  '\\bthe\\s+(house|senate)\\b',
  'u\\.s\\.\\s+(house|senate|congress)\\b',
  // House/Senate + action/political qualifier — blocks real-estate/school false hits
  '\\bhouse\\s+(of\\s+rep|race|seat|bill|vote|district|speaker|majority|minority|floor|republican|democrat|gop|pass|fail|approv|reject|primary)',
  '\\bsenate\\s+(race|seat|bill|vote|majority|republican|democrat|gop|pass|fail|approv|runoff|hearing|floor)',
  // Congress + action verb
  '\\bcongress\\s+(pass|fail|vote|approv|block|reject|debate|overrid|introduc)',
  // Unambiguous ballot/primary phrases
  '\\bballot\\s+(measure|initiative|access|box)',
  '\\bprimary\\s+(election|race|result|runoff)',
].join('|'), 'i');

// Patterns that are reliable false positives even if they match RELEVANCE_RE
const FALSE_POSITIVE_RE = /\bhousing\s+(market|price|crisis|cost|bubble|data)\b|\bhouse\s+(fire|price|market|sale|hunt|warm|clean|plant|music|party)\b|\bprimary\s+(school|care|colo[ur]|source|sector)\b|\b(real\s+estate|property\s+market|home\s+price)\b/i;

// Reject social-media/aggregator noise: excessive symbols, hashtag-spam, RT
const NOISE_TITLE_RE = /^(BREAKING[\s:!]|WATCH[\s:!]|READ[\s:!]|THREAD[\s:!]|RT\s+@)|#{2,}|\*{3,}|[★✦✩☆♦]{2,}/;

function isRelevant(title, description) {
  const text = `${title} ${description}`;
  if (NOISE_TITLE_RE.test(title))     return false;
  if (FALSE_POSITIVE_RE.test(text))   return false;
  return RELEVANCE_RE.test(text);
}

// ── AUTO-TAGGING ───────────────────────────────────────────────────────────────
const TAG_RULES = [
  { tag: 'Major Update',  keywords: ['redistrict', 'retirement', 'retires', 'indictment', 'court ruling', 'primary result', 'flips', 'upset', 'breaks record'] },
  { tag: 'House',         keywords: ['house', 'representative', 'h.r.', 'speaker'] },
  { tag: 'Senate',        keywords: ['senate', 'senator', 's.', 'filibuster', 'cloture'] },
  { tag: 'Federal',       keywords: ['congress', 'federal', 'white house', 'administration', 'legislation', 'bill', 'vote'] },
  { tag: 'Governorship',  keywords: ['governor', 'gubernatorial', 'statehouse'] },
  { tag: 'Primary',       keywords: ['primary', 'runoff', 'nomination'] },
  { tag: 'Redistricting',  keywords: ['redistrict', 'gerrymander', 'congressional map', 'district map', 'remap'] },
];

const NEWS_EXPIRY_MS  = 24 * 60 * 60 * 1000; // articles live for 24 hours
const NEWS_EMERGENCY_CAP = 300;              // hard ceiling to prevent runaway growth

// ── HELPERS ────────────────────────────────────────────────────────────────────

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function autoTag(title, description) {
  const combined = `${title} ${description}`.toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    if (containsKeyword(combined, rule.keywords)) {
      tags.push(rule.tag);
    }
  }
  return [...new Set(tags)];
}

function stripHtml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseDate(raw) {
  if (!raw) return new Date().toISOString();
  try {
    return new Date(raw).toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'DCDossier/1.0 (+https://github.com/dcdossier/Generational-Mid-terms)' },
      timeout: 15000,
    });
    if (!res.ok) {
      console.warn(`[SKIP] ${feed.source}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);

    const channel = parsed?.rss?.channel || parsed?.feed || {};
    const rawItems = channel.item || channel.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.map(item => {
      const title       = stripHtml(item.title || '');
      const url         = String(item.link || item['@_href'] || item.id || '').trim().replace(/^<|>$/g, '');
      const description = stripHtml(item.description || item.summary || item.content || '').slice(0, 280);
      const date        = parseDate(item.pubDate || item.published || item.updated || item['dc:date']);
      return { title, url, source: feed.source, date, description, forceTags: feed.forceTags || [] };
    }).filter(i => i.url && i.title);
  } catch (err) {
    console.warn(`[ERROR] ${feed.source}: ${err.message}`);
    return [];
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[fetch-news] Starting…');

  // Load existing data
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[fetch-news] Could not read data.json:', err.message);
    process.exit(1);
  }

  // ── 24-HOUR REPOSITORY ──────────────────────────────────────────────────────
  // Backfill fetched_at on any existing articles that predate this field
  const now = Date.now();
  data.news = (data.news || []).map(n =>
    n.fetched_at ? n : { ...n, fetched_at: new Date().toISOString() }
  );

  // Expire articles older than 24 hours
  const beforeExpiry = data.news.length;
  data.news = data.news.filter(n => now - new Date(n.fetched_at).getTime() < NEWS_EXPIRY_MS);
  if (data.news.length < beforeExpiry)
    console.log(`[fetch-news] Expired ${beforeExpiry - data.news.length} articles older than 24h.`);

  // Build dedup set from the surviving 24h window
  const existingUrls = new Set(data.news.map(n => n.url));

  // Fetch all feeds concurrently
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const allItems = results.flat();

  console.log(`[fetch-news] Fetched ${allItems.length} raw items from ${FEEDS.length} feeds.`);

  let newCount = 0;

  for (const item of allItems) {
    // Skip already-seen URLs
    if (existingUrls.has(item.url)) continue;

    // Filter by relevance
    if (!isRelevant(item.title, item.description)) continue;

    // Auto-tag
    const tags = [...new Set([...autoTag(item.title, item.description), ...(item.forceTags || [])])];

    data.news.push({
      title: item.title,
      url: item.url,
      source: item.source,
      date: item.date,
      fetched_at: new Date().toISOString(), // timestamp when first added — drives 24h expiry
      tags,
      description: item.description,
    });

    existingUrls.add(item.url);
    newCount++;
  }

  // Sort by date descending; apply emergency cap
  data.news.sort((a, b) => new Date(b.date) - new Date(a.date));
  if (data.news.length > NEWS_EMERGENCY_CAP) {
    data.news = data.news.slice(0, NEWS_EMERGENCY_CAP);
    console.log(`[fetch-news] Emergency cap hit — trimmed to ${NEWS_EMERGENCY_CAP}.`);
  }

  // Write back
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[fetch-news] Done. Added ${newCount} new items. Repository total: ${data.news.length} articles (24h window).`);
}

main().catch(err => {
  console.error('[fetch-news] Fatal error:', err);
  process.exit(1);
});
