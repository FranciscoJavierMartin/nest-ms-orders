import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { PrismaClient } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersPaginationDto } from './dto/orders-pagination.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { NATS_SERVICE } from '../config';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger('OrdersService');

  constructor(
    @Inject(NATS_SERVICE) private readonly productsClient: ClientProxy,
  ) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  public async create(createOrderDto: CreateOrderDto) {
    const productIds = createOrderDto.items.map((i) => i.productId);
    const products = await firstValueFrom(
      this.productsClient.send({ cmd: 'validate_products' }, productIds),
    ).catch(() => {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: `Products in order were not found`,
      });
    });

    const totalAmount = createOrderDto.items.reduce((acc, orderItem) => {
      return acc + orderItem.price * orderItem.quantity;
    }, 0);

    const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
      return acc + orderItem.quantity;
    }, 0);

    const order = await this.order.create({
      data: {
        totalAmount,
        totalItems,
        OrderItem: {
          createMany: {
            data: createOrderDto.items,
          },
        },
      },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true,
          },
        },
      },
    });

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((p) => p.id === orderItem.productId).name,
      })),
    };
  }

  public async findAll(ordersPaginationDto: OrdersPaginationDto) {
    const totalPages = await this.order.count({
      where: { status: ordersPaginationDto.status },
    });

    const currentPage = ordersPaginationDto.page;
    const perPage = ordersPaginationDto.limit;

    return {
      data: await this.order.findMany({
        skip: (currentPage - 1) * perPage,
        take: perPage,
        where: {
          status: ordersPaginationDto.status,
        },
      }),
      meta: {
        total: totalPages,
        page: currentPage,
        lastPage: Math.ceil(totalPages / perPage),
      },
    };
  }

  public async findOne(id: string) {
    const order = await this.order
      .findFirstOrThrow({
        where: { id: id },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productId: true,
            },
          },
        },
      })
      .catch(() => {
        throw new RpcException({
          status: HttpStatus.NOT_FOUND,
          message: `Order with id ${id} not found`,
        });
      });

    const products = await firstValueFrom(
      this.productsClient.send(
        { cmd: 'validate_products' },
        order.OrderItem.map((orderItem) => orderItem.productId),
      ),
    ).catch(() => {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: `Products in order were not found`,
      });
    });

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((p) => p.id === orderItem.productId).name,
      })),
    };
  }

  async changeStatus({ id, status }: ChangeOrderStatusDto) {
    return this.order
      .update({
        where: { id },
        data: { status },
      })
      .catch(() => {
        throw new RpcException({
          status: HttpStatus.NOT_FOUND,
          message: `Order with id ${id} not found`,
        });
      });
  }
}
