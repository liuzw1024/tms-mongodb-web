const { ResultData, ResultFault } = require('tms-koa')
const Base = require('../../base')
const { nanoid } = require('nanoid')
const ObjectId = require('mongodb').ObjectId

/** 空间用户管理控制器 */
class Coworker extends Base {
  constructor(...args) {
    super(...args)
  }
  /** 执行方法调用前检查 */
  async tmsBeforeEach() {
    if (!this.client)
      return new ResultFault('只有通过认证的用户才可以执行该操作')

    return true
  }
  /**
   * @swagger
   *
   * /api/admin/bucket/coworker/invite:
   *   post:
   *     tags:
   *       - admin
   *     description:
   *       创建空间邀请。
   *     security:
   *       - HeaderTokenAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/bucket'
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               nickname:
   *                 description: 被邀请用户的昵称。
   *                 type: string
   *     responses:
   *       '200':
   *         description: result为4位字符的邀请码
   *         content:
   *           application/json:
   *             schema:
   *               "$ref": "#/components/schemas/ResponseData"
   */
  async invite() {
    if (!this.bucket) return new ResultFault('没有指定邀请的空间')

    const { nickname } = this.request.body
    if (!nickname) return new ResultFault('没有指定被邀请用户的昵称')

    /*检查nickname*/
    const clBkt = this.mongoClient.db('tms_admin').collection('bucket')
    const coworkerBucket = await clBkt.findOne({
      name: this.bucket.name,
      'coworkers.nickname': nickname,
    })
    if (coworkerBucket)
      return new ResultFault(`用户【${nickname}】已经是授权用户，不能重复邀请`)

    const clLog = this.mongoClient
      .db('tms_admin')
      .collection('bucket_invite_log')

    const inviteLog = await clLog.findOne({
      bucket: this.bucket.name,
      nickname,
      acceptAt: { $exists: false },
    })
    if (inviteLog) {
      // 重新发出邀请，更新邀请过期时间
      await clLog.updateOne(
        { _id: ObjectId(inviteLog._id) },
        { $set: { expireAt: new Date(Date.now() + (3600 * 8 + 1800) * 1000) } }
      )
      return new ResultData(inviteLog.code)
    }

    // 生成数据库系统名
    let tries = 0,
      existInvite
    let code = nanoid(4)
    while (tries <= 2) {
      existInvite = await clLog.findOne({ bucket: this.bucket.name, code })
      if (!existInvite) break
      code = nanoid(4)
      tries++
    }
    if (existInvite) return new ResultFault('无法生成有效的邀请码')

    const now = new Date()
    const createAt = new Date(now.getTime() + 3600 * 8 * 1000)
    const expireAt = new Date(createAt.getTime() + 1800 * 1000)

    const invite = {
      inviter: this.client.id,
      bucket: this.bucket.name,
      code,
      createAt,
      expireAt,
      nickname,
    }

    return clLog.insertOne(invite).then(() => new ResultData(code))
  }
  /**
   * @swagger
   *
   * /api/admin/bucket/coworker/accept:
   *   post:
   *     tags:
   *       - admin
   *     description:
   *       接受空间邀请。
   *     security:
   *       - HeaderTokenAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/bucket'
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               code:
   *                 description: 邀请码。
   *                 type: string
   *               nickname:
   *                 description: 被邀请用户的昵称。
   *                 type: string
   *             required:
   *               - code
   *               - nickname
   *     responses:
   *       '200':
   *         description: result为ok
   *         content:
   *           application/json:
   *             schema:
   *               "$ref": "#/components/schemas/ResponseData"
   */
  async accept() {
    const { bucket } = this.request.query
    if (!bucket) return new ResultFault('没有指定邀请的空间')

    const clLog = this.mongoClient
      .db('tms_admin')
      .collection('bucket_invite_log')

    const { code, nickname } = this.request.body
    if (!code || !nickname) return new ResultFault('没有提供又有效参数')

    const invite = await clLog.findOne({
      bucket,
      code,
      nickname,
      expireAt: { $gt: new Date() },
    })

    if (!invite)
      return new ResultFault(
        '没有匹配的邀请，请确认邀请码、昵称是否正确，要求是否已过期'
      )

    if (invite.acceptAt)
      return new ResultFault('邀请码已经使用，不允许重复使用')

    const invitee = this.client.id // 被邀请人

    /*加入bucket授权列表*/
    const clBucket = this.mongoClient.db('tms_admin').collection('bucket')
    const coworkerQuery = {
      name: bucket,
      'coworkers.id': invitee,
    }
    const coworkerBucket = await clBucket.findOne(coworkerQuery)
    if (coworkerBucket) {
      await clBucket.updateOne(coworkerQuery, {
        $set: { 'coworkers.$.nickname': nickname },
      })
    } else {
      await clBucket.updateOne(
        { name: bucket },
        {
          $push: { coworkers: { id: invitee, nickname } },
        }
      )
    }

    return clLog
      .updateOne(
        { _id: ObjectId(invite._id) },
        { $set: { invitee, acceptAt: new Date(Date.now() + 3600 * 8 * 1000) } }
      )
      .then(() => new ResultData('ok'))
  }
  /**
   * @swagger
   *
   * /api/admin/bucket/coworker/remove:
   *   get:
   *     tags:
   *       - admin
   *     description:
   *       删除授权访问用户。
   *     security:
   *       - HeaderTokenAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/bucket'
   *       - name: coworker
   *         description: 被邀请用户的id
   *         in: query
   *         schema:
   *           type: string
   *         required: true
   *     responses:
   *       '200':
   *         description: result为ok
   *         content:
   *           application/json:
   *             schema:
   *               "$ref": "#/components/schemas/ResponseData"
   */
  async remove() {
    if (!this.bucket) return new ResultFault('没有指定邀请的空间')

    const { coworker } = this.request.query

    const clBkt = this.mongoClient.db('tms_admin').collection('bucket')
    const coworkerBucket = await clBkt.findOne({
      name: this.bucket.name,
      'coworkers.id': { $in: [coworker, parseInt(coworker)] },
    })

    if (!coworkerBucket) return new ResultFault('指定的用户不存在')

    return clBkt
      .updateOne(
        {
          _id: ObjectId(coworkerBucket._id),
        },
        {
          $pull: { coworkers: { id: { $in: [coworker, parseInt(coworker)] } } },
        }
      )
      .then(() => new ResultData('ok'))
  }
}

module.exports = Coworker
