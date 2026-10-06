#!/usr/bin/env node
'use strict';

/**
 * fetch-news.js
 * Fetches RSS feeds from 154 national and state-level sources (midterm_rss_feeds_v2.xlsx),
 * scores items for midterm relevance (see RELEVANCE SCORE), drops items older than
 * 7 days, caps each publisher at 10 per run, auto-tags, deduplicates against existing
 * data.json, and writes the updated news array back to data.json.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const he = require('he');
const { recordStatus, saveStatus } = require('./status');
const { COMMON_SURNAMES, candidateNames, cleanText, splitGoogleNewsTitle, loadMembers, loadBriefs, seatState, escapeRe } = require('./news-utils');

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
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:apnews.com+congress+midterm',                       source: 'Google News: apnews.com congress midterm' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:reuters.com+congress+midterm',                      source: 'Google News: reuters.com congress midterm' },
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
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Politico+poll+congress+senate+house+2026',               source: 'Google News: Politico poll congress senate house 2026' },

  // ARIZONA
  { url: 'https://azmirror.com/feed/localFeed/',                                                                                   source: 'Arizona Mirror' },
  { url: 'https://azcapitoltimes.com/feed/',                                                                                       source: 'Arizona Capitol Times' },
  { url: 'https://www.azcentral.com/arcio/rss/',                                                                                   source: 'Arizona Republic' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Arizona+2026',                              source: 'Google News: Emerson poll Arizona 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Arizona+2026',                           source: 'Google News: Quinnipiac poll Arizona 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Arizona+2026',                              source: 'Google News: Suffolk poll Arizona 2026' },

  // CALIFORNIA
  { url: 'https://calmatters.org/feed/',                                                                                           source: 'CalMatters' },
  { url: 'https://www.latimes.com/rss2.0.xml',                                                                                    source: 'Los Angeles Times' },
  { url: 'https://www.sacbee.com/arcio/rss/',                                                                                     source: 'Sacramento Bee' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Berkeley+IGS+poll+California+2026',                      source: 'Google News: Berkeley IGS poll California 2026' },
  { url: 'https://www.ppic.org/feed/',                                                                                             source: 'PPIC' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+California+2026',                           source: 'Google News: Emerson poll California 2026' },

  // COLORADO
  { url: 'https://coloradosun.com/feed/',                                                                                          source: 'Colorado Sun' },
  { url: 'https://www.coloradopolitics.com/feed/',                                                                                 source: 'Colorado Politics' },
  { url: 'https://cpr.org/feed/',                                                                                                  source: 'CPR News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Colorado+2026',                             source: 'Google News: Emerson poll Colorado 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Colorado+2026',                          source: 'Google News: Quinnipiac poll Colorado 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Colorado+2026',                             source: 'Google News: Suffolk poll Colorado 2026' },

  // FLORIDA
  { url: 'https://floridapolitics.com/feed/',                                                                                      source: 'Florida Politics' },
  { url: 'https://floridaphoenix.com/feed/localFeed/',                                                                             source: 'Florida Phoenix' },
  { url: 'https://www.tampabay.com/feed/',                                                                                         source: 'Tampa Bay Times' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Stetson+poll+Florida+2026',                              source: 'Google News: Stetson poll Florida 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Florida+2026',                              source: 'Google News: Emerson poll Florida 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Florida+2026',                           source: 'Google News: Quinnipiac poll Florida 2026' },

  // GEORGIA
  { url: 'https://georgiarecorder.com/feed/localFeed/',                                                                            source: 'Georgia Recorder' },
  { url: 'https://www.ajc.com/arcio/rss/',                                                                                        source: 'Atlanta Journal-Constitution' },
  { url: 'https://www.gpb.org/rss.xml',                                                                                           source: 'GPB News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Georgia+2026',                              source: 'Google News: Emerson poll Georgia 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Georgia+2026',                           source: 'Google News: Quinnipiac poll Georgia 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Georgia+2026',                              source: 'Google News: Suffolk poll Georgia 2026' },

  // IOWA
  { url: 'https://iowacapitaldispatch.com/feed/localFeed/',                                                                        source: 'Iowa Capital Dispatch' },
  { url: 'https://iowastartingline.com/feed/',                                                                                     source: 'Iowa Starting Line' },
  { url: 'http://www.thegazette.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                       source: 'The Gazette (IA)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Selzer+poll+Iowa+2026',                                  source: 'Google News: Selzer poll Iowa 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Iowa+2026',                                 source: 'Google News: Emerson poll Iowa 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Iowa+2026',                              source: 'Google News: Quinnipiac poll Iowa 2026' },

  // MAINE
  { url: 'https://mainemorningstar.com/feed/localFeed/',                                                                           source: 'Maine Morning Star' },
  { url: 'https://www.pressherald.com/feed/',                                                                                      source: 'Portland Press Herald' },
  { url: 'https://www.bangordailynews.com/feed/',                                                                                  source: 'Bangor Daily News' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Maine+2026',                                source: 'Google News: Emerson poll Maine 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Maine+2026',                                source: 'Google News: Suffolk poll Maine 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Maine+2026',                             source: 'Google News: Quinnipiac poll Maine 2026' },

  // MICHIGAN
  { url: 'https://bridgemi.com/feed/',                                                                                             source: 'Bridge Michigan' },
  { url: 'https://michiganadvance.com/feed/localFeed/',                                                                            source: 'Michigan Advance' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:detroitnews.com+Michigan+election+2026',            source: 'Google News: detroitnews.com Michigan election 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=EPIC-MRA+poll+Michigan+2026',                            source: 'Google News: EPIC-MRA poll Michigan 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Glengariff+poll+Michigan+2026',                          source: 'Google News: Glengariff poll Michigan 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Michigan+2026',                          source: 'Google News: Quinnipiac poll Michigan 2026' },

  // MONTANA
  { url: 'https://montanafreepress.org/feed/',                                                                                     source: 'Montana Free Press' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:billingsgazette.com+Montana+election+2026',         source: 'Google News: billingsgazette.com Montana election 2026' },
  { url: 'https://www.mtpr.org/index.rss',                                                                                        source: 'Montana Public Radio' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Montana+2026',                              source: 'Google News: Emerson poll Montana 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Montana+2026',                           source: 'Google News: Quinnipiac poll Montana 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Montana+2026',                              source: 'Google News: Suffolk poll Montana 2026' },

  // NEBRASKA
  { url: 'https://nebraskaexaminer.com/feed/localFeed/',                                                                           source: 'Nebraska Examiner' },
  { url: 'http://omaha.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                                source: 'Omaha World-Herald' },
  { url: 'http://journalstar.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory',                          source: 'Lincoln Journal Star' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Selzer+poll+Nebraska+2026',                              source: 'Google News: Selzer poll Nebraska 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Siena+poll+Nebraska+2026',                               source: 'Google News: Siena poll Nebraska 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Nebraska+2026',                             source: 'Google News: Emerson poll Nebraska 2026' },

  // NEVADA
  { url: 'https://thenevadaindependent.com/feed/',                                                                                 source: 'Nevada Independent' },
  { url: 'https://nevadacurrent.com/feed/localFeed/',                                                                              source: 'Nevada Current' },
  { url: 'https://www.reviewjournal.com/feed/',                                                                                    source: 'Las Vegas Review-Journal' },
  { url: 'https://thenevadaindependent.com/articles/polls/feed/',                                                                  source: 'Nevada Ind. Polls' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Nevada+2026',                               source: 'Google News: Emerson poll Nevada 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Nevada+2026',                            source: 'Google News: Quinnipiac poll Nevada 2026' },

  // NEW HAMPSHIRE
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:unionleader.com+New+Hampshire+election+2026',       source: 'Google News: unionleader.com New Hampshire election 2026' },
  { url: 'https://www.concordmonitor.com/feed/',                                                                                   source: 'Concord Monitor' },
  { url: 'https://newhampshirebulletin.com/feed/localFeed/',                                                                       source: 'NH Bulletin' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Saint+Anselm+NHIOP+poll+New+Hampshire+2026',             source: 'Google News: Saint Anselm NHIOP poll New Hampshire 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UNH+Survey+Center+poll+New+Hampshire+2026',              source: 'Google News: UNH Survey Center poll New Hampshire 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Hampshire+2026',                        source: 'Google News: Suffolk poll New Hampshire 2026' },

  // NEW JERSEY
  { url: 'https://njspotlightnews.org/feed/',                                                                                      source: 'NJ Spotlight News' },
  { url: 'https://njmonitor.com/feed/',                                                                                            source: 'NJ Monitor' },
  { url: 'https://insidernj.com/feed/',                                                                                            source: 'Insider NJ' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Monmouth+poll+New+Jersey+2026',                          source: 'Google News: Monmouth poll New Jersey 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+Jersey+2026',                        source: 'Google News: Quinnipiac poll New Jersey 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Jersey+2026',                           source: 'Google News: Suffolk poll New Jersey 2026' },

  // NEW MEXICO
  { url: 'https://nmpoliticalreport.com/feed/',                                                                                    source: 'NM Political Report' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:abqjournal.com+New+Mexico+election+2026',           source: 'Google News: abqjournal.com New Mexico election 2026' },
  { url: 'https://sourcenm.com/feed/localFeed/',                                                                                   source: 'Source New Mexico' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+New+Mexico+2026',                           source: 'Google News: Emerson poll New Mexico 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+New+Mexico+2026',                           source: 'Google News: Suffolk poll New Mexico 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+Mexico+2026',                        source: 'Google News: Quinnipiac poll New Mexico 2026' },

  // NEW YORK
  { url: 'https://www.cityandstateny.com/rss.xml',                                                                                source: 'City & State NY' },
  { url: 'https://nystateofpolitics.com/feed/',                                                                                    source: 'NY State of Politics' },
  { url: 'https://www.timesunion.com/rss/',                                                                                       source: 'Times Union (Albany)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Siena+poll+New+York+2026',                               source: 'Google News: Siena poll New York 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+New+York+2026',                          source: 'Google News: Quinnipiac poll New York 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Marist+poll+New+York+2026',                              source: 'Google News: Marist poll New York 2026' },

  // NORTH CAROLINA
  { url: 'https://ncnewsline.com/feed/localFeed/',                                                                                 source: 'NC Newsline' },
  { url: 'https://carolinapublicpress.org/feed/',                                                                                  source: 'Carolina Public Press' },
  { url: 'https://www.wunc.org/politics.rss',                                                                                     source: 'WUNC Politics' },
  { url: 'https://www.elon.edu/u/elon-poll/feed/',                                                                                source: 'Elon Poll (NC)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Meredith+poll+North+Carolina+2026',                      source: 'Google News: Meredith poll North Carolina 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=High+Point+University+poll+North+Carolina+2026',         source: 'Google News: High Point University poll North Carolina 2026' },

  // OHIO
  { url: 'https://ohiocapitaljournal.com/feed/localFeed/',                                                                         source: 'Ohio Capital Journal' },
  { url: 'https://www.cleveland.com/arc/outboundfeeds/rss/',                                                                      source: 'Cleveland Plain Dealer' },
  { url: 'https://www.dispatch.com/arcio/rss/',                                                                                   source: 'Columbus Dispatch' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=BGSU+poll+Ohio+2026',                                    source: 'Google News: BGSU poll Ohio 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Ohio+2026',                              source: 'Google News: Quinnipiac poll Ohio 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Baldwin+Wallace+poll+Ohio+2026',                         source: 'Google News: Baldwin Wallace poll Ohio 2026' },

  // PENNSYLVANIA
  { url: 'https://www.spotlightpa.org/feeds/full.xml',                                                                            source: 'Spotlight PA' },
  { url: 'https://www.inquirer.com/arcio/rss/',                                                                                   source: 'Philadelphia Inquirer' },
  { url: 'https://www.post-gazette.com/rss',                                                                                      source: 'Pittsburgh Post-Gazette' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Franklin+Marshall+poll+Pennsylvania+2026',               source: 'Google News: Franklin Marshall poll Pennsylvania 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Pennsylvania+2026',                      source: 'Google News: Quinnipiac poll Pennsylvania 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Muhlenberg+poll+Pennsylvania+2026',                      source: 'Google News: Muhlenberg poll Pennsylvania 2026' },

  // TEXAS
  { url: 'https://www.texastribune.org/feed/',                                                                                    source: 'Texas Tribune' },
  { url: 'https://www.houstonchronicle.com/arcio/rss/',                                                                           source: 'Houston Chronicle' },
  { url: 'https://www.texasobserver.org/feed/',                                                                                    source: 'Texas Observer' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UT+Texas+Politics+poll+Texas+2026',                      source: 'Google News: UT Texas Politics poll Texas 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=UT+Tyler+poll+Texas+2026',                               source: 'Google News: UT Tyler poll Texas 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Texas+2026',                                source: 'Google News: Emerson poll Texas 2026' },

  // VIRGINIA
  { url: 'https://virginiamercury.com/feed/localFeed/',                                                                            source: 'Virginia Mercury' },
  { url: 'https://richmond.com/feed/',                                                                                             source: 'Richmond Times-Dispatch' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=VPAP+Virginia+election+2026',                            source: 'Google News: VPAP Virginia election 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=CNU+Wason+poll+Virginia+2026',                           source: 'Google News: CNU Wason poll Virginia 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Virginia+2026',                             source: 'Google News: Emerson poll Virginia 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Virginia+2026',                             source: 'Google News: Suffolk poll Virginia 2026' },

  // WASHINGTON STATE
  { url: 'https://washingtonstatestandard.com/feed/localFeed/',                                                                    source: 'Washington State Standard' },
  { url: 'https://www.cascadepbs.org/articles/briefs/rss/',                                                                       source: 'Crosscut / Cascade PBS' },
  { url: 'https://www.seattletimes.com/feed/',                                                                                    source: 'Seattle Times' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Elway+Research+poll+Washington+2026',                    source: 'Google News: Elway Research poll Washington 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Washington+state+2026',                     source: 'Google News: Emerson poll Washington state 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Suffolk+poll+Washington+state+2026',                     source: 'Google News: Suffolk poll Washington state 2026' },

  // WISCONSIN
  { url: 'https://wisconsinexaminer.com/feed/localFeed/',                                                                          source: 'Wisconsin Examiner' },
  { url: 'https://www.jsonline.com/arcio/rss/',                                                                                   source: 'Milwaukee Journal Sentinel' },
  { url: 'https://wisconsinwatch.org/feed/',                                                                                      source: 'Wisconsin Watch' },
  { url: 'https://law.marquette.edu/poll/feed/',                                                                                   source: 'Marquette Law Poll (WI)' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+Wisconsin+2026',                            source: 'Google News: Emerson poll Wisconsin 2026' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Wisconsin+2026',                         source: 'Google News: Quinnipiac poll Wisconsin 2026' },


  // REDISTRICTING (force-tagged)
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=redistricting+2026+congress', source: 'Google News: redistricting 2026 congress', forceTags: ['Major Update', 'Redistricting'] },

  // CONNECTICUT (Chris Murphy; new state feeds per India-interest-sources.xlsx)
  { url: 'https://ctmirror.org/feed/',                                                                                                source: 'CT Mirror' },
  { url: 'https://www.courant.com/news/politics/?widgetName=rssfeed&widgetContentId=755799&getXmlFeed=true',                          source: 'Hartford Courant – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Connecticut+2026',                          source: 'Google News: Quinnipiac poll Connecticut 2026' },

  // ILLINOIS (Krishnamoorthi, Davis; new state feeds)
  { url: 'https://illinoispolicy.org/feed/',                                                                                          source: 'Illinois Policy Institute' },
  { url: 'https://capitolnewsillinois.com/feed/',                                                                                     source: 'Capitol News Illinois' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Paul+Simon+Institute+poll+Illinois+2026',                   source: 'Google News: Paul Simon Institute poll Illinois 2026' },

  // INDIANA (André Carson; new state feeds)
  { url: 'https://indianacapitalchronicle.com/feed/',                                                                                 source: 'Indiana Capital Chronicle' },
  { url: 'https://www.indystar.com/rss/news/politics/',                                                                               source: 'IndyStar – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Ball+State+CBER+poll+Indiana+2026',                         source: 'Google News: Ball State CBER poll Indiana 2026' },

  // MARYLAND (Van Hollen; new state feeds)
  { url: 'https://www.marylandmatters.org/feed/',                                                                                     source: 'Maryland Matters' },
  { url: 'https://www.wbaltv.com/news/politics/rss.xml',                                                                              source: 'WBAL-TV Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Goucher+poll+Maryland+2026',                                source: 'Google News: Goucher poll Maryland 2026' },

  // MASSACHUSETTS (Lynch, Markey; new state feeds)
  { url: 'https://www.masslive.com/arc/outboundfeeds/rss/section/politics/',                                                          source: 'MassLive – Politics' },
  { url: 'https://commonwealthbeacon.org/feed/',                                                                                      source: 'CommonWealth Beacon' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=MassINC+poll+Massachusetts+2026',                           source: 'Google News: MassINC poll Massachusetts 2026' },

  // MINNESOTA (Omar; new state feeds)
  { url: 'https://www.minnpost.com/rss.xml',                                                                                          source: 'MinnPost' },
  { url: 'https://www.startribune.com/local/politics/?format=rss',                                                                    source: 'Star Tribune – Politics' },
  { url: 'https://minnesotareformer.com/feed/',                                                                                        source: 'Minnesota Reformer' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Star+Tribune+Minnesota+poll+2026',                          source: 'Google News: Star Tribune Minnesota poll 2026' },

  // SOUTH CAROLINA (Wilson, Graham; new state feeds)
  { url: 'https://scdailygazette.com/feed/',                                                                                          source: 'SC Daily Gazette' },
  { url: 'https://www.postandcourier.com/politics/feed/',                                                                             source: 'Post and Courier – Politics' },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Winthrop+poll+South+Carolina+2026',                         source: 'Google News: Winthrop poll South Carolina 2026' },

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

// ── RELEVANCE SCORE ────────────────────────────────────────────────────────────
// An item is kept when its score is at least MIN_SCORE. Each rule counts once:
//   +3  title has a core election term
//   +2  title or summary names a tracked candidate/seat (assets/briefs.json) or
//       an India-relevant member (MEMBERS in india.html)
//   +1  summary has a campaign/polling term
//   -5  title or summary hits the blocklist
const MIN_SCORE = 3;

const TITLE_TERMS_RE = /\b(mid-?terms?|2026 elections?|senate races?|house races?|governor['’]s races?|gubernatorial races?|battlegrounds?|generic ballot|redistricting|primar(y|ies)(?!\s+(care|school|source|colou?r|sector|residence|reason))|runoffs?|nominees?)\b/i;
const SUMMARY_TERMS_RE = /\b(poll(s|ing|ster)?|campaign(s|ing)?|ballots?|candidates?|districts?|forecasts?|inside elections)\b/i;
const SUMMARY_NAMES_RE = /\b(Cook|Sabato)\b/; // case-sensitive: not "cook" the verb
const BLOCKLIST_RE = new RegExp([
  '\\bsports?\\b', '\\b(NFL|NBA|MLB|NHL|MLS)\\b', '\\bplayoffs?\\b', '\\bquarterback\\b', '\\btouchdowns?\\b',
  '\\bcollege athletics\\b', '\\bNCAA\\b', '\\bathletic (director|department)\\b',
  '\\bweather\\b', '\\btornado (watch|warning)\\b', '\\bheat advisory\\b', '\\bwinter storm\\b',
  '\\bcrimes?\\b', '\\bpolice (blotter|log)\\b',
  '\\bobituar(y|ies)\\b',
  '\\brecipes?\\b',
  '\\bdaylight saving',
  '\\bcelebrit(y|ies)\\b',
].join('|'), 'i');
// Social-media noise carried over from the old filter (case-sensitive: "BREAKING:", not "Breaking the…")
const NOISE_TITLE_RE = /^(BREAKING|WATCH|READ|THREAD)[\s:!]|^RT\s+@|#{2,}|\*{3,}|[★✦✩☆♦]{2,}/;

const ORDINAL = n => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[(n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] || 'th');

// Builds the +2 matcher from assets/briefs.json and the MEMBERS list in india.html.
function buildEntityMatcher() {
  const fullNames = new Set();
  const surnames = new Map(); // surname → count of people with it
  const seatPatterns = [];
  const addPerson = (name, allowSurname) => {
    fullNames.add(name);
    if (!allowSurname) return;
    const last = name.split(' ').filter(w => !/^(Jr|Sr|II|III|IV)\.?$/.test(w)).pop();
    if (last && last.length >= 5 && !COMMON_SURNAMES.has(last.toLowerCase())) surnames.set(last, (surnames.get(last) || 0) + 1);
  };

  try {
    for (const [id, b] of Object.entries(loadBriefs())) {
      candidateNames(b.dem).forEach(n => addPerson(n, true));
      candidateNames(b.rep).forEach(n => addPerson(n, true));
      candidateNames(b.others).forEach(n => addPerson(n, false));
      const state = seatState(b);
      const house = id.match(/^([A-Z]{2})-(\d+)$/);
      if (house) {
        const n = parseInt(house[2], 10);
        seatPatterns.push(`\\b${house[1]}-0?${n}\\b`, `${escapeRe(state)}['’]s ${ORDINAL(n)} (Congressional )?District`);
      } else if (id.startsWith('Senate-') && state) {
        seatPatterns.push(`${escapeRe(state)} (U\\.S\\. )?Senate (race|seat|contest|primary|nominee)`, `Senate (race|seat|contest) in ${escapeRe(state)}`);
      } else if (id.startsWith('Gov-') && state) {
        seatPatterns.push(`${escapeRe(state)} (governor['’]s|gubernatorial) (race|contest|primary)`, `(governor['’]s|gubernatorial) race in ${escapeRe(state)}`);
      }
    }
  } catch (err) {
    console.warn(`[fetch-news] Could not read assets/briefs.json: ${err.message}`);
  }

  for (const m of loadMembers()) addPerson(m.name, true);

  const uniqueSurnames = [...surnames].filter(([, n]) => n === 1).map(([s]) => s);
  const words = [...fullNames, ...uniqueSurnames].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`(?<![\\p{L}])(${words.join('|')})(?![\\p{L}])|${seatPatterns.join('|')}`, 'u');
  console.log(`[fetch-news] Entity matcher: ${fullNames.size} names, ${uniqueSurnames.length} surnames, ${seatPatterns.length} seat patterns`);
  return re;
}

let ENTITY_RE = null;

// Returns { score, reasons } for one item.
function scoreItem(title, summary) {
  ENTITY_RE = ENTITY_RE || buildEntityMatcher();
  const text = `${title} ${summary}`;
  let score = 0;
  const reasons = [];
  const t = title.match(TITLE_TERMS_RE);
  if (t) { score += 3; reasons.push(`+3 "${t[0]}"`); }
  const e = text.match(ENTITY_RE);
  if (e) { score += 2; reasons.push(`+2 "${e[0]}"`); }
  const s = summary.match(SUMMARY_TERMS_RE) || summary.match(SUMMARY_NAMES_RE);
  if (s) { score += 1; reasons.push(`+1 "${s[0]}"`); }
  const b = text.match(BLOCKLIST_RE) || title.match(NOISE_TITLE_RE);
  if (b) { score -= 5; reasons.push(`-5 "${b[0]}"`); }
  return { score, reasons };
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

// Returns an ISO date, or null when the feed gives no usable pubDate.
function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(typeof raw === 'object' ? raw['#text'] : raw);
  return isNaN(d) ? null : d.toISOString();
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // drop items published more than 7 days ago
const MAX_PER_SOURCE = 10;                    // per publisher, per run

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'DCDossier/1.0 (+https://github.com/dcdossier/Generational-Mid-terms)' },
      timeout: 15000,
    });
    const xml = await res.text();
    const bytes = Buffer.byteLength(xml);
    if (!res.ok) {
      console.warn(`[SKIP] ${feed.source}: HTTP ${res.status}, ${bytes} bytes`);
      recordStatus(feed.statusName, { group: 'news', ok: false, error: `HTTP ${res.status}` });
      return [];
    }
    // processEntities off: he decodes entities later, and large feeds no longer
    // hit fast-xml-parser's entity expansion limit (Axios, Spotlight PA).
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false });
    const parsed = parser.parse(xml);

    const channel = parsed?.rss?.channel || parsed?.feed || {};
    const rawItems = channel.item || channel.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    const isGoogleNews = feed.url.includes('news.google.com');
    const mapped = items.map(item => {
      let title         = cleanText(item.title);
      let source        = feed.source;
      if (isGoogleNews) {
        const split = splitGoogleNewsTitle(title, item.source);
        title = split.title;
        if (split.publisher) source = split.publisher;
      }
      const link        = typeof item.link === 'object' ? (item.link['@_href'] || '') : item.link;
      const url         = he.decode(String(link || item['@_href'] || item.id || '').trim().replace(/^<|>$/g, ''));
      let description   = cleanText(item.description || item.summary || item.content || '');
      // Google News summaries just repeat the headline and publisher
      if (isGoogleNews && description.startsWith(title)) description = '';
      const date        = parseDate(item.pubDate || item.published || item.updated || item['dc:date']);
      return { title, url, source, feed: feed.source, date, description: description.slice(0, 280), forceTags: feed.forceTags || [] };
    }).filter(i => i.url && i.title);
    if (mapped.length) console.log(`[fetch] ${feed.source}: HTTP ${res.status}, ${bytes} bytes, ${mapped.length} items`);
    else console.warn(`[EMPTY] ${feed.source}: HTTP ${res.status}, ${bytes} bytes, 0 items`);
    recordStatus(feed.statusName, { group: 'news', ok: true, count: mapped.length });
    return mapped;
  } catch (err) {
    console.warn(`[ERROR] ${feed.source}: ${err.message}`);
    recordStatus(feed.statusName, { group: 'news', ok: false, error: err.message });
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

  // Unique status.json names (two feeds can share a source label)
  const seenNames = {};
  for (const feed of FEEDS) {
    seenNames[feed.source] = (seenNames[feed.source] || 0) + 1;
    feed.statusName = `News: ${feed.source}` + (seenNames[feed.source] > 1 ? ` (${seenNames[feed.source]})` : '');
  }

  // Fetch all feeds concurrently
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const allItems = results.flat();

  const working = results.filter(r => r.length).length;
  console.log(`[fetch-news] Fetched ${allItems.length} raw items from ${FEEDS.length} feeds (${working} returned items).`);
  recordStatus('News feeds (all)', { group: 'news', primary: true, ok: true, count: allItems.length,
    error: allItems.length ? null : `0 items from ${FEEDS.length} feeds` });

  // ── SELECT: age → score → dedupe → per-source cap ──────────────────────────
  const counts = { noDate: 0, tooOld: 0, lowScore: 0, duplicate: 0, sourceCap: 0 };
  const candidates = [];
  const rejected = [];
  const seenThisRun = new Set();
  // Same story via two feeds (e.g. The Hill and The Hill (House)) has different URLs
  const titleKey = t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const existingTitles = new Set(data.news.map(n => titleKey(n.title)));
  for (const item of allItems) {
    if (!item.date) { counts.noDate++; continue; }
    if (now - new Date(item.date).getTime() > MAX_AGE_MS) { counts.tooOld++; continue; }
    const { score, reasons } = scoreItem(item.title, item.description);
    if (score < MIN_SCORE) { counts.lowScore++; rejected.push({ ...item, score, reasons }); continue; }
    const key = titleKey(item.title);
    if (existingUrls.has(item.url) || seenThisRun.has(item.url) || existingTitles.has(key) || seenThisRun.has(key)) { counts.duplicate++; continue; }
    seenThisRun.add(item.url);
    seenThisRun.add(key);
    candidates.push({ ...item, score, reasons });
  }

  // Best-scoring, then newest, first — so the cap keeps each outlet's top items
  candidates.sort((a, b) => b.score - a.score || new Date(b.date) - new Date(a.date));
  const perSource = {};
  const kept = [];
  for (const item of candidates) {
    perSource[item.source] = (perSource[item.source] || 0) + 1;
    if (perSource[item.source] > MAX_PER_SOURCE) { counts.sourceCap++; continue; }
    kept.push(item);
    data.news.push({
      title: item.title,
      url: item.url,
      source: item.source,
      date: item.date,
      fetched_at: new Date().toISOString(), // timestamp when first added — drives 24h expiry
      tags: [...new Set([...autoTag(item.title, item.description), ...(item.forceTags || [])])],
      description: item.description,
      score: item.score,
    });
  }
  const newCount = kept.length;

  // ── RUN SUMMARY ─────────────────────────────────────────────────────────────
  const keptBySource = {};
  for (const item of kept) keptBySource[item.source] = (keptBySource[item.source] || 0) + 1;
  const topSources = Object.entries(keptBySource).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('[fetch-news] ── Summary ─────────────────────────────');
  console.log(`  Kept (new):            ${kept.length}`);
  console.log(`  Dropped by score (<${MIN_SCORE}): ${counts.lowScore}`);
  console.log(`  Dropped by age:        ${counts.tooOld + counts.noDate} (${counts.tooOld} older than 7 days, ${counts.noDate} with no pubDate)`);
  console.log(`  Dropped by source cap: ${counts.sourceCap} (max ${MAX_PER_SOURCE} per source)`);
  console.log(`  Duplicates:            ${counts.duplicate} (same URL or headline)`);
  console.log(`  Top sources: ${topSources.map(([s, n]) => `${s} (${n})`).join(', ') || 'none'}`);

  // Optional: write kept/rejected items with their scores for review
  if (process.env.NEWS_REPORT) {
    const brief = i => ({ score: i.score, reasons: i.reasons, title: i.title, source: i.source, date: i.date });
    fs.writeFileSync(process.env.NEWS_REPORT, JSON.stringify({
      kept: kept.map(brief),
      rejected: rejected.sort((a, b) => b.score - a.score).map(brief),
    }, null, 2));
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
  saveStatus();
  process.exit(0);
}

main().catch(err => {
  console.error('[fetch-news] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
