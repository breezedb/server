const pgp = require('pg-promise')({});
const db = pgp(process.env.DATABASE_URL);
const Listener = require("./listener");
const Query = require("./query");
const assert = require("assert");
const s = require("underscore.string");
const graphQL = require("./graphql");
const consola = require('consola');

class Velzy {
  constructor() {
    const handler = {
      get(target, key) {
        if (key in target) {
          return target[key]
        } else {
          return new Query({ tableName: key, db: db });
        }
      }
    }
    var proxy = new Proxy(this, handler);
    return proxy;
  }
  async initListener() {
    this.listener = new Listener(db);
    try {
      await this.listener.connect(db);
      return { success: true, message: "Listening for velzy.received" }
    } catch (err) {
      throw new Error("Can't connect listener: ", err.message)
    }
    return this.listener;
  }
  wireEvents(io) {
    //sigh
    const self = this;
    //this fires when a record is updated in PG
    this.listener.on("velzy.received", async args => {
      console.log("Notification processing", args);
      //this can be an add/update/delete OR a table creation
      if (args.action === "table_created" || args.action === "table_dropped") {
        //console.log("Looks like we just created a table!", args.tableName);
        consola.info({
          message: `Table ${args.tableName} - ${args.action}`,
          badge: true
        })
        io.sockets.emit(`velzy_${args.action}`, {
          table: args.tableName
        });
      } else {
        //products:update:1
        consola.info({
          message: `Record changed for ${args.tableName}: ${args.action} ${args.id}`,
          badge: true
        });
        if(args.action === "DELETE"){
          io.sockets.emit("velzy_changeset", {
            tableName: args.tableName,
            action: args.action,
            id: args.id,
            record: null
          });
        }else{
          const record = await self[args.tableName].get(args.id)
          console.log("Emitting changeset", args);
          io.sockets.emit("velzy_changeset", {
            tableName: args.tableName,
            action: args.action,
            id: args.id,
            record: record.body
          });
        }

      }
    });
  }

  async run(sql, params = []) {
    return await db.any(sql, params);
  }
  async first(sql, params = []) {
    return await db.oneOrNone(sql, params);
  }
  async search(tableName, term){
    const sql = "select * from velzy.search($1, $2)";
    return this.run(sql, [tableName, term]);
  }
  async delete(tableName, id){
    assert(id, "No tableName, no delete.")
    assert(id, "No id, no delete.")
    return this[tableName].delete(id);
  }
  async query({collection, pageSize=100, where=null, orderBy="id", orderDir="asc", page=0}){
    assert(collection, "No collection passed can't continue");
    //const sql = "select id, body, created_at, updated_at from velzy.filter($1, $2, $3, $4, $5, $6)";
    //return this.run(sql, [collection, where, pageSize, page,orderBy,orderDir])
    const sql = "select * from velzy.query($1, $2, $3, $4, $5, $6)";
    const offset = (page - 1) < 0 ? 0 : page - 1;

    const result = await db.any(sql, [
      collection,
      where,
      pageSize,
      offset,
      orderBy,
      orderDir
    ]);

    return result;
  }
  async single({collection, id}){
    assert(collection, "No collection passed can't continue");
    assert(id, "No id passed can't continue");
    const sql = "select id, body, created_at, updated_at from velzy.get($1, $2)";
    return this.first(sql, [collection, id]);
  }
  async find_one(tableName, criteria) {
    const sql = "select * from velzy.find_one($1, $2)";
    const result = await db.oneOrNone(sql, [tableName, criteria]);
    return result;
  }
  async tableList() {
    const sql = "select * from velzy.table_list();"
    return db.any(sql);
  }
  async contains(tableName, key, term) {
    const sql = "select * from velzy.fuzzy($1, $2, $3)";
    const result = await db.any(sql, [tableName, key, term]);
    return result;
  }
  async modify(tableName, id, mod) {
    const sql = "select * from velzy.modify($1, $2, $3)"
    const result = await db.oneOrNone(sql, [tableName, id, mod]);
    return result.res;
  }
  async startsWith(tableName, key, term) {
    const sql = "select * from velzy.starts_with($1, $2, $3)";
    const result = await db.any(sql, [tableName, key, term]);

    return result;
  }
  async endsWith(tableName, key, term) {
    const sql = "select * from velzy.ends_with($1, $2, $3)";
    const result = await db.any(sql, [tableName, key, term]);

    return result;
  }

  close() {
    db.$pool.end();
  }
  async graphQLSchema(cb = null){
    const schema = await graphQL.build(this, cb);
    return schema;
  }
  async getSampleSet() {
    const tables = await this.tableList();
    //eek! Executing in a loop seems kind of horrible but
    //we'll figure it out
    const out = [];
    for (let table of tables) {
      const sql = `select body from public.${table.table_name} limit 1`
      const res = await this.first(sql);
      out.push({
        table_name: table.table_name,
        db: this,
        formatted: s.titleize(table.table_name),
        example: res.body
      })
    }
    return out;
  }
}

module.exports = new Velzy();
